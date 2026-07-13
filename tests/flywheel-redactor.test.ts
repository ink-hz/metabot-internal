import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/flywheel/redactor.js';

describe('flywheel redactor', () => {
  it.each([
    ['sk-ant-secret-value', '[REDACTED]'],
    ['xoxb-123456789-secret', '[REDACTED]'],
    ['Bearer abc.def-123', 'Bearer [REDACTED]'],
    ['AKIAIOSFODNN7EXAMPLE', '[REDACTED]'],
    ['postgresql://agent:super-secret@127.0.0.1/db', 'postgresql://agent:[REDACTED]@127.0.0.1/db'],
    ['-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----', '[REDACTED]'],
  ])('redacts credential pattern %s', (input, expected) => {
    expect(createRedactor([]).sanitize(input)).toBe(expected);
  });

  it('replaces exact process secrets and removes sensitive keys recursively', () => {
    const redactor = createRedactor(['exact-known-secret']);
    expect(redactor.sanitize({
      text: 'prefix exact-known-secret suffix',
      nested: { password: 'nope', apiToken: 'nope', safe: 'ok' },
      items: [{ credential: 'nope' }, { value: 'safe' }],
    })).toEqual({
      text: 'prefix [REDACTED] suffix',
      nested: { safe: 'ok' },
      items: [{}, { value: 'safe' }],
    });
  });

  it('drops thinking structures', () => {
    const redactor = createRedactor([]);
    expect(redactor.sanitize({ type: 'thinking', thinking: 'private chain' })).toBeNull();
    expect(redactor.sanitize([{ type: 'text', text: 'ok' }, { type: 'thinking', text: 'private' }]))
      .toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('preserves long normal Chinese content byte-for-byte', () => {
    const content = '中文 **Markdown** 😀 𠮷 é\n'.repeat(10_000);
    expect(createRedactor([]).sanitize(content)).toBe(content);
  });
});
