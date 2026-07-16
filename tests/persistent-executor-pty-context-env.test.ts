import { beforeEach, describe, expect, it, vi } from 'vitest';

const capturedPtyOptions: Array<Record<string, unknown>> = [];

vi.mock('../src/engines/claude/pty/pty-query.js', () => ({
  ptyQuery: ({ options }: { options: Record<string, unknown> }) => {
    capturedPtyOptions.push(options);
    const stream = (async function* () {
      yield await new Promise<never>(() => {});
    })();
    return Object.assign(stream, { interrupt: async () => {} });
  },
}));

import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';

const logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

describe('PersistentClaudeExecutor PTY context environment', () => {
  beforeEach(() => {
    capturedPtyOptions.length = 0;
  });

  it('passes the 200k context guard to the interactive Claude process', async () => {
    const executor = new PersistentClaudeExecutor({
      cwd: '/tmp',
      logger,
      model: 'claude-opus-4-8',
      backend: 'pty',
      idleTimeoutMs: 0,
    });

    await executor.start();

    expect(capturedPtyOptions).toHaveLength(1);
    expect(capturedPtyOptions[0].env).toMatchObject({
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
    });
  });
});
