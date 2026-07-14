import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import {
  authenticationError,
  invalidRequest,
  sendAnthropicError,
  upstreamUnavailable,
} from './anthropic-errors.js';
import {
  InvalidAnthropicRequestError,
  promoteToolResultImages,
} from './image-promotion.js';

const DEFAULT_MAX_MESSAGE_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ClaudeGatewayAdapterLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export interface ClaudeGatewayAdapterOptions {
  upstreamBaseUrl: string;
  authToken: string;
  logger: ClaudeGatewayAdapterLogger;
  maxMessageBodyBytes?: number;
}

export interface ClaudeGatewayAdapter {
  baseUrl: string;
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {}

function safeTokenEqual(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  const apiKey = request.headers['x-api-key'];
  return Array.isArray(apiKey) ? apiKey[0] : apiKey;
}

function sanitizedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'host') continue;
    result[name] = value;
  }
  return result;
}

function upstreamUrl(baseUrl: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://127.0.0.1');
  const target = new URL(baseUrl);
  const prefix = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  target.pathname = `${prefix}${incoming.pathname}` || '/';
  target.search = incoming.search;
  target.hash = '';
  return target;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function proxyRequest(args: {
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
  body?: Buffer;
  logger: ClaudeGatewayAdapterLogger;
  promotedCount: number;
  requestBytes?: number;
}): void {
  const { request, response, target, body, logger, promotedCount } = args;
  const startedAt = Date.now();
  const headers = sanitizedHeaders(request.headers);
  if (body) headers['content-length'] = String(body.length);
  const transport = target.protocol === 'https:' ? https : http;
  let upstreamResponded = false;

  const upstreamRequest = transport.request(target, {
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    upstreamResponded = true;
    const responseHeaders = sanitizedHeaders(upstreamResponse.headers);
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
    response.once('finish', () => {
      logger.info({
        method: request.method,
        path: target.pathname,
        status: upstreamResponse.statusCode,
        durationMs: Date.now() - startedAt,
        requestBytes: args.requestBytes,
        promotedCount,
      }, 'Claude gateway adapter request completed');
    });
  });

  upstreamRequest.once('error', (error) => {
    logger.warn({
      method: request.method,
      path: target.pathname,
      durationMs: Date.now() - startedAt,
      errorCategory: 'upstream_unavailable',
    }, 'Claude gateway adapter upstream unavailable');
    if (upstreamResponded || response.headersSent) {
      response.destroy(error);
      return;
    }
    sendAnthropicError(response, 502, upstreamUnavailable());
  });

  if (body) {
    upstreamRequest.end(body);
  } else {
    request.pipe(upstreamRequest);
  }
}

export async function startClaudeGatewayAdapter(
  options: ClaudeGatewayAdapterOptions,
): Promise<ClaudeGatewayAdapter> {
  const baseUrl = new URL(options.upstreamBaseUrl);
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('Claude gateway upstream must use HTTP or HTTPS');
  }
  if (!options.authToken) throw new Error('Claude gateway adapter requires an auth token');
  const maxMessageBodyBytes = options.maxMessageBodyBytes ?? DEFAULT_MAX_MESSAGE_BODY_BYTES;

  const server = createServer((request, response) => {
    void (async () => {
      if (!safeTokenEqual(requestToken(request), options.authToken)) {
        options.logger.warn({ method: request.method, path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname },
          'Claude gateway adapter rejected unauthenticated request');
        sendAnthropicError(response, 401, authenticationError());
        request.resume();
        return;
      }

      const requestUrl = request.url ?? '/';
      const target = upstreamUrl(baseUrl, requestUrl);
      const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
      if (request.method !== 'POST' || pathname !== '/v1/messages') {
        proxyRequest({ request, response, target, logger: options.logger, promotedCount: 0 });
        return;
      }

      let raw: Buffer;
      try {
        raw = await readBody(request, maxMessageBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendAnthropicError(response, 400, invalidRequest('Anthropic request body exceeds the configured limit.'));
          return;
        }
        throw error;
      }

      let body: Buffer;
      let promotedCount: number;
      try {
        const promotion = promoteToolResultImages(raw);
        body = promotion.body;
        promotedCount = promotion.kind === 'transformed' ? promotion.promotedCount : 0;
      } catch (error) {
        if (error instanceof InvalidAnthropicRequestError) {
          sendAnthropicError(response, 400, invalidRequest());
          return;
        }
        throw error;
      }

      proxyRequest({
        request,
        response,
        target,
        body,
        logger: options.logger,
        promotedCount,
        requestBytes: raw.length,
      });
    })().catch((error) => {
      options.logger.error({ errorCategory: 'adapter_internal_error' }, 'Claude gateway adapter request failed');
      if (!response.headersSent) sendAnthropicError(response, 500, upstreamUnavailable());
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Claude gateway adapter failed to bind loopback');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    },
  };
}
