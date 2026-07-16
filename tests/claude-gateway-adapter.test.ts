import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { startClaudeGatewayAdapter } from '../src/engines/claude/compatibility/adapter.js';

const TOKEN = 'adapter-test-token';
const secretMarker = 'secret-prompt-marker';
const imageData = Buffer.from('adapter-image').toString('base64');

type CapturedRequest = {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
};

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

function captureUpstream(
  responder: (request: CapturedRequest, response: import('node:http').ServerResponse) => void,
) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const captured = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      responder(captured, response);
    });
  });
  return { server, requests };
}

function loggerCapture() {
  const entries: unknown[] = [];
  const logger = {
    info: (...args: unknown[]) => entries.push(args),
    warn: (...args: unknown[]) => entries.push(args),
    error: (...args: unknown[]) => entries.push(args),
    debug: (...args: unknown[]) => entries.push(args),
  };
  return { logger, entries };
}

async function requestAdapter(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Buffer }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

describe('Claude gateway loopback adapter', () => {
  it('filters only profile-declared beta flags on message requests', async () => {
    const upstream = captureUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const upstreamUrl = await listen(upstream.server);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({
      upstreamBaseUrl: upstreamUrl,
      authToken: TOKEN,
      logger,
      unsupportedRequestBetas: [
        'redact-thinking-2026-02-12',
        'prompt-caching-scope-2026-01-05',
      ],
    });
    const raw = Buffer.from('{"model":"claude-opus-4-8","messages":[]}');

    try {
      await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST',
        headers: {
          'anthropic-beta': [
            'claude-code-20250219',
            ' redact-thinking-2026-02-12',
            ' effort-2025-11-24',
            ' prompt-caching-scope-2026-01-05',
          ].join(','),
        },
        body: raw,
      });
      await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST',
        headers: {
          'anthropic-beta': 'redact-thinking-2026-02-12,prompt-caching-scope-2026-01-05',
        },
        body: raw,
      });

      expect(upstream.requests[0].headers['anthropic-beta']).toBe(
        'claude-code-20250219, effort-2025-11-24',
      );
      expect(upstream.requests[1].headers['anthropic-beta']).toBeUndefined();
      expect(upstream.requests[0].body).toEqual(raw);
      expect(upstream.requests[1].body).toEqual(raw);
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });

  it('preserves beta headers when no compatibility policy is supplied', async () => {
    const upstream = captureUpstream((_request, response) => response.end('{"ok":true}'));
    const upstreamUrl = await listen(upstream.server);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({ upstreamBaseUrl: upstreamUrl, authToken: TOKEN, logger });
    const betaHeader = 'redact-thinking-2026-02-12, prompt-caching-scope-2026-01-05';

    try {
      await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST',
        headers: { 'anthropic-beta': betaHeader },
        body: Buffer.from('{"messages":[]}'),
      });
      expect(upstream.requests[0].headers['anthropic-beta']).toBe(betaHeader);
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });

  it('forwards native WebSearch request bytes and tool type unchanged', async () => {
    const upstream = captureUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const upstreamUrl = await listen(upstream.server);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({ upstreamBaseUrl: upstreamUrl, authToken: TOKEN, logger });
    const raw = Buffer.from(
      '{ "model":"claude-opus-4-8", "tools":[{"type":"web_search_20250305","name":"web_search"}], "messages":[{"role":"user","content":"search"}] }',
    );

    try {
      const result = await requestAdapter(adapter.baseUrl, '/v1/messages?beta=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });

      expect(result.response.status).toBe(200);
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0].url).toBe('/v1/messages?beta=true');
      expect(upstream.requests[0].body).toEqual(raw);
      expect(upstream.requests[0].body.toString()).toContain('web_search_20250305');
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });

  it('promotes the exact nested image shape and leaves PDF requests unchanged', async () => {
    const upstream = captureUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const upstreamUrl = await listen(upstream.server);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({ upstreamBaseUrl: upstreamUrl, authToken: TOKEN, logger });
    const imageRaw = Buffer.from(JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'tool-image',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } }],
      }] }],
    }));
    const pdfRaw = Buffer.from(JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'tool-pdf',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'pdf' } }],
      }] }],
    }));

    try {
      await requestAdapter(adapter.baseUrl, '/v1/messages', { method: 'POST', body: imageRaw });
      await requestAdapter(adapter.baseUrl, '/v1/messages', { method: 'POST', body: pdfRaw });

      const imageBody = JSON.parse(upstream.requests[0].body.toString()) as {
        messages: Array<{ content: Array<{ type: string }> }>;
      };
      expect(imageBody.messages[0].content.map((block) => block.type)).toEqual(['tool_result', 'image']);
      expect(upstream.requests[1].body).toEqual(pdfRaw);
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });

  it('streams upstream status, headers, and SSE bytes unchanged', async () => {
    const chunks = [
      Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\n'),
      Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    ];
    const upstream = captureUpstream((_request, response) => {
      response.writeHead(201, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
      response.write(chunks[0]);
      response.end(chunks[1]);
    });
    const upstreamUrl = await listen(upstream.server);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({ upstreamBaseUrl: upstreamUrl, authToken: TOKEN, logger });

    try {
      const result = await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST', body: Buffer.from('{"messages":[]}'),
      });
      expect(result.response.status).toBe(201);
      expect(result.response.headers.get('x-upstream')).toBe('yes');
      expect(result.body).toEqual(Buffer.concat(chunks));
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });

  it('returns non-retryable 400 envelopes for malformed and oversized requests', async () => {
    const upstream = captureUpstream((_request, response) => response.end('unexpected'));
    const upstreamUrl = await listen(upstream.server);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({
      upstreamBaseUrl: upstreamUrl,
      authToken: TOKEN,
      logger,
      maxMessageBodyBytes: 32,
    });

    try {
      const malformed = await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST', body: Buffer.from('{"messages":['),
      });
      const oversized = await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST', body: Buffer.alloc(33, 1),
      });
      expect(malformed.response.status).toBe(400);
      expect(JSON.parse(malformed.body.toString()).error.type).toBe('invalid_request_error');
      expect(oversized.response.status).toBe(400);
      expect(JSON.parse(oversized.body.toString()).error.type).toBe('invalid_request_error');
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });

  it('returns a retryable-shaped 502 when upstream is unavailable and never retries POST', async () => {
    const dead = createServer();
    const deadUrl = await listen(dead);
    await close(dead);
    const { logger } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({ upstreamBaseUrl: deadUrl, authToken: TOKEN, logger });

    try {
      const result = await requestAdapter(adapter.baseUrl, '/v1/messages', {
        method: 'POST', body: Buffer.from('{"messages":[]}'),
      });
      expect(result.response.status).toBe(502);
      expect(result.response.headers.get('retry-after')).toBeNull();
      expect(JSON.parse(result.body.toString()).error.type).toBe('api_error');
    } finally {
      await adapter.close();
    }
  });

  it('rejects unauthenticated callers and never logs request bodies or tokens', async () => {
    const upstream = captureUpstream((_request, response) => response.end('{"ok":true}'));
    const upstreamUrl = await listen(upstream.server);
    const { logger, entries } = loggerCapture();
    const adapter = await startClaudeGatewayAdapter({ upstreamBaseUrl: upstreamUrl, authToken: TOKEN, logger });

    try {
      const unauthorized = await fetch(`${adapter.baseUrl}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ prompt: secretMarker }),
      });
      expect(unauthorized.status).toBe(401);
      expect(upstream.requests).toHaveLength(0);
      const logs = JSON.stringify(entries);
      expect(logs).not.toContain(TOKEN);
      expect(logs).not.toContain(secretMarker);
    } finally {
      await adapter.close();
      await close(upstream.server);
    }
  });
});
