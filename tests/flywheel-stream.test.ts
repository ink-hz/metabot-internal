import { describe, expect, it, vi } from 'vitest';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';

describe('StreamProcessor flywheel hooks', () => {
  it('records raw evidence and tool lifecycle without changing card output', () => {
    const recordToolCall = vi.fn();
    const recordEvidence = vi.fn();
    const context = {
      recordToolCall,
      recordEvidence,
    };
    const processor = new StreamProcessor('用户问题', context);

    const running = processor.processMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } }] },
    } as any);
    const runningStatus = running.toolCalls[0]?.status;
    const complete = processor.processMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    } as any);

    expect(runningStatus).toBe('running');
    expect(complete.toolCalls[0]).toMatchObject({ name: 'Read', status: 'done' });
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool_name: 'Read', status: 'running' }));
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool_name: 'Read', status: 'completed' }));
    expect(recordEvidence).toHaveBeenCalledTimes(2);
  });

  it('accumulates input, output and cache token classes across model calls', () => {
    const processor = new StreamProcessor('prompt');
    processor.processMessage({ type: 'stream_event', event: {
      type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } },
    } } as any);
    processor.processMessage({ type: 'stream_event', event: {
      type: 'message_delta', usage: { output_tokens: 4 },
    } } as any);
    processor.processMessage({ type: 'stream_event', event: {
      type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 6, cache_creation_input_tokens: 7 } },
    } } as any);
    processor.processMessage({ type: 'stream_event', event: {
      type: 'message_delta', usage: { output_tokens: 3 },
    } } as any);
    expect(processor.getTokenUsage()).toEqual({
      inputTokens: 15, outputTokens: 7, cacheReadTokens: 26, cacheCreationTokens: 37,
    });
  });
});
