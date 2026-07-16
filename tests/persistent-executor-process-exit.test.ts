import { describe, expect, it } from 'vitest';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';
import { ClaudeProcessExitError } from '../src/engines/claude/pty/process-exit-error.js';

const logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

describe('PersistentClaudeExecutor typed process exits', () => {
  it('rejects the active turn and enters crash handling instead of ending cleanly', async () => {
    const failure = new ClaudeProcessExitError({
      exitCode: 1,
      phase: 'prompt_dispatched',
      sessionRef: 'abc12345',
      completedOutputRecovered: false,
      toolSideEffectSeen: false,
    });
    async function* failedStream(): AsyncGenerator<any> {
      throw failure;
    }

    const executor = new PersistentClaudeExecutor({
      cwd: '/tmp', logger, idleTimeoutMs: 0, maxRestartAttempts: 0,
    }) as any;
    executor.state = 'ready';
    executor.rawStream = failedStream();
    const crashed: unknown[] = [];
    executor.on('crashed', (error: unknown) => crashed.push(error));
    const turn = executor.nextTurn('你好');

    await executor.consumeLoop();

    const iterator = turn.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(failure);
    expect(crashed).toEqual([failure]);
    expect(executor.getState()).toBe('closed');
    expect(executor.hasActiveTurn()).toBe(false);
  });
});
