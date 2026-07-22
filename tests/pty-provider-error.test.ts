import { describe, expect, it } from 'vitest';
import { extractProviderError } from '../src/engines/claude/pty/provider-error.js';
import { synthesizeResult } from '../src/engines/claude/pty/message-adapter.js';

describe('Claude PTY provider error envelope', () => {
  it('extracts the bounded status and user-safe message from a terminal API error', () => {
    expect(extractProviderError({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 504,
      message: {
        content: [{ type: 'text', text: 'API Error: The operation timed out.' }],
      },
    })).toEqual({
      kind: 'api_error',
      status: 504,
      message: 'API Error: The operation timed out.',
    });
  });

  it('redacts credential-shaped values and caps the message at 500 characters', () => {
    const extracted = extractProviderError({
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        content: [{
          type: 'text',
          text: `API Error: Authorization: Bearer secret-bearer-token x-api-key=secret-api-key ${'x'.repeat(800)}`,
        }],
      },
    });

    expect(extracted.message).not.toContain('secret-bearer-token');
    expect(extracted.message).not.toContain('secret-api-key');
    expect(extracted.message).toContain('[REDACTED]');
    expect(extracted.message.length).toBeLessThanOrEqual(500);
  });

  it('uses a generic bounded message when the record has no text content', () => {
    expect(extractProviderError({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: { content: [{ type: 'tool_result', content: { private: 'body' } }] },
    })).toEqual({
      kind: 'api_error',
      status: 429,
      message: 'API Error: provider request failed (429)',
    });
  });

  it('copies sanitized provider errors into the synthetic terminal result', () => {
    const result = synthesizeResult({
      sessionId: 'session-1',
      isError: true,
      errors: ['API Error: The operation timed out.'],
    });

    expect(result.is_error).toBe(true);
    expect(result.errors).toEqual(['API Error: The operation timed out.']);
  });
});
