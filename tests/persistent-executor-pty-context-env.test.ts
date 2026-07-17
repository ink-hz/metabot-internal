import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('constructs a shared gateway turn lease only when the fleet lock directory is configured', async () => {
    vi.stubEnv('METABOT_CLAUDE_GATEWAY_LOCK_DIR', '/tmp/metabot-shared-gateway-lock');
    vi.stubEnv('METABOT_INSTANCE_NAME', 'metabot-marketing-prospecting');
    vi.stubEnv('METABOT_CLAUDE_GATEWAY_GLOBAL_CAPACITY', '15');
    vi.stubEnv('METABOT_CLAUDE_GATEWAY_INSTANCE_CAPACITY', '3');
    const executor = new PersistentClaudeExecutor({
      cwd: '/tmp',
      logger,
      model: 'claude-opus-4-8',
      backend: 'pty',
      idleTimeoutMs: 0,
    });

    await executor.start();

    expect(capturedPtyOptions[0].gatewayTurnLease).toMatchObject({ acquire: expect.any(Function) });
  });

  it('rejects an invalid configured gateway capacity', async () => {
    vi.stubEnv('METABOT_CLAUDE_GATEWAY_LOCK_DIR', '/tmp/metabot-invalid-gateway-capacity');
    vi.stubEnv('METABOT_CLAUDE_GATEWAY_GLOBAL_CAPACITY', 'many');
    const executor = new PersistentClaudeExecutor({
      cwd: '/tmp', logger, model: 'claude-opus-4-8', backend: 'pty', idleTimeoutMs: 0,
    });

    await expect(executor.start()).rejects.toThrow('global capacity must be an integer');
  });
});
