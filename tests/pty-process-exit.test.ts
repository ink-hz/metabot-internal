import { describe, expect, it } from 'vitest';
import {
  ClaudeProcessExitError,
  advanceClaudeTurnPhase,
  isClaudeProcessExitError,
} from '../src/engines/claude/pty/process-exit-error.js';
import { AsyncQueue } from '../src/utils/async-queue.js';

describe('Claude PTY process exit contract', () => {
  it('allows only monotonic turn-phase advances', () => {
    expect(advanceClaudeTurnPhase('accepted', 'process_starting')).toBe('process_starting');
    expect(advanceClaudeTurnPhase('process_starting', 'prompt_dispatched')).toBe('prompt_dispatched');
    expect(advanceClaudeTurnPhase('prompt_dispatched', 'prompt_dispatched')).toBe('prompt_dispatched');
    expect(() => advanceClaudeTurnPhase('side_effect_started', 'output_started')).toThrow(/phase regression/i);
  });

  it('exposes only structured non-sensitive exit metadata', () => {
    const error = new ClaudeProcessExitError({
      exitCode: 1,
      signal: undefined,
      phase: 'prompt_dispatched',
      sessionRef: 'abc12345',
      completedOutputRecovered: false,
      toolSideEffectSeen: false,
    });

    expect(isClaudeProcessExitError(error)).toBe(true);
    expect(error.code).toBe('CLAUDE_PROCESS_EXIT');
    expect(error.message).toBe('Claude process exited unexpectedly');
    const serialized = JSON.stringify(error);
    expect(serialized).not.toMatch(/promptText|credential|thinking|screenContents/i);
    expect(serialized).not.toContain('complete-session-id-value');
  });

  it('drains already-observed events before rejecting an async queue', async () => {
    const queue = new AsyncQueue<string>();
    const failure = new Error('process exited');
    queue.enqueue('tool-use-observed');
    queue.fail(failure);
    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: 'tool-use-observed', done: false });
    await expect(iterator.next()).rejects.toBe(failure);
  });
});
