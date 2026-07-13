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
});
