import type { ServerResponse } from 'node:http';

export interface AnthropicErrorEnvelope {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'api_error';
    message: string;
  };
}

export function invalidRequest(message = 'The Anthropic request is invalid.'): AnthropicErrorEnvelope {
  return { type: 'error', error: { type: 'invalid_request_error', message } };
}

export function authenticationError(): AnthropicErrorEnvelope {
  return {
    type: 'error',
    error: { type: 'authentication_error', message: 'Loopback adapter authentication failed.' },
  };
}

export function upstreamUnavailable(): AnthropicErrorEnvelope {
  return {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'The configured upstream gateway is temporarily unavailable.',
    },
  };
}

export function sendAnthropicError(
  response: ServerResponse,
  status: number,
  envelope: AnthropicErrorEnvelope,
): void {
  const body = Buffer.from(JSON.stringify(envelope));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  });
  response.end(body);
}
