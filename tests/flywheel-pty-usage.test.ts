import { describe, expect, it } from 'vitest';
import { accumulatePtyUsage } from '../src/engines/claude/pty/pty-query.js';
import { synthesizeResult } from '../src/engines/claude/pty/message-adapter.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';

describe('PTY flywheel token accounting', () => {
  it('preserves and accumulates all four token classes across assistant calls', () => {
    const usage = {};
    accumulatePtyUsage(usage, assistantUsage(10, 20, 30, 4));
    accumulatePtyUsage(usage, assistantUsage(5, 6, 7, 3));

    expect(usage).toMatchObject({
      inputTokens: 15,
      outputTokens: 7,
      cacheReadTokens: 26,
      cacheCreationTokens: 37,
      contextInputTokens: 18,
      contextOutputTokens: 3,
    });

    const processor = new StreamProcessor('prompt');
    processor.processMessage(synthesizeResult({ sessionId: 'session', model: 'pty-model', usage }));
    expect(processor.getTokenUsage()).toEqual({
      inputTokens: 15, outputTokens: 7, cacheReadTokens: 26, cacheCreationTokens: 37,
    });
  });
});

function assistantUsage(input: number, cacheRead: number, cacheCreation: number, output: number) {
  return {
    type: 'assistant',
    message: {
      model: 'pty-model',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
      },
    },
  };
}
