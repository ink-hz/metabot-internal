import { describe, expect, it } from 'vitest';

import {
  buildRuntimeStatus,
  resolveReleaseSha,
} from '../src/reliability/runtime-status.js';
import { BotRegistry } from '../src/api/bot-registry.js';

describe('buildRuntimeStatus', () => {
  it('returns sanitized per-bot connection, model, backend, and release facts', () => {
    const result = buildRuntimeStatus({
      releaseSha: 'abc123',
      bots: [
        {
          name: 'marketing-bot',
          platform: 'feishu',
          engine: 'claude',
          model: 'claude-opus-4-8',
          backend: 'pty',
          connectionStatus: () => ({
            state: 'connected',
            reconnectAttempts: 0,
            lastConnectTime: 1_752_500_000_000,
          }),
        },
      ],
    });

    expect(result).toEqual({
      releaseSha: 'abc123',
      backend: 'pty',
      bots: [
        {
          name: 'marketing-bot',
          platform: 'feishu',
          engine: 'claude',
          model: 'claude-opus-4-8',
          backend: 'pty',
          ws: {
            state: 'connected',
            reconnectAttempts: 0,
            lastConnectTime: 1_752_500_000_000,
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/appSecret|apiKey|token|client/iu);
  });

  it('does not turn an observation exception into a forged SDK state', () => {
    const result = buildRuntimeStatus({
      releaseSha: 'abc123',
      bots: [
        {
          name: 'hr-bot',
          platform: 'feishu',
          engine: 'claude',
          model: 'claude-opus-4-8',
          backend: 'pty',
          connectionStatus: () => {
            throw new Error('SDK internals containing a token');
          },
        },
      ],
    });

    expect(result.bots[0].ws).toBeNull();
    expect(JSON.stringify(result)).not.toContain('SDK internals');
  });

  it('reports mixed backends without hiding each bot backend', () => {
    const result = buildRuntimeStatus({
      releaseSha: 'abc123',
      bots: [
        { name: 'a', platform: 'feishu', engine: 'claude', model: 'claude-opus-4-8', backend: 'pty' },
        { name: 'b', platform: 'web', engine: 'claude', model: 'claude-opus-4-8', backend: 'sdk' },
      ],
    });

    expect(result.backend).toBe('mixed');
    expect(result.bots.map(({ backend }) => backend)).toEqual(['pty', 'sdk']);
    expect(result.bots.map(({ ws }) => ws)).toEqual([null, null]);
  });
});

describe('resolveReleaseSha', () => {
  it('trims a configured release and otherwise returns unknown', () => {
    expect(resolveReleaseSha('  abc123  ')).toBe('abc123');
    expect(resolveReleaseSha('')).toBe('unknown');
    expect(resolveReleaseSha(undefined)).toBe('unknown');
  });
});

describe('BotRegistry runtime sources', () => {
  it('selects only sanitized fields and a lazy connection reader', () => {
    const registry = new BotRegistry();
    registry.register({
      name: 'marketing-bot',
      platform: 'feishu',
      config: {
        name: 'marketing-bot',
        engine: 'claude',
        claude: {
          defaultWorkingDirectory: '/workspace/marketing',
          maxTurns: undefined,
          maxBudgetUsd: undefined,
          model: 'claude-opus-4-8',
          apiKey: 'must-not-leak',
          outputsBaseDir: '/tmp/outputs',
          downloadsDir: '/tmp/downloads',
          backend: 'pty',
        },
      },
      bridge: {} as never,
      sender: {} as never,
      connectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    });

    const sources = registry.listRuntimeSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      name: 'marketing-bot',
      platform: 'feishu',
      engine: 'claude',
      model: 'claude-opus-4-8',
      backend: 'pty',
    });
    expect(sources[0].connectionStatus?.()).toEqual({
      state: 'connected',
      reconnectAttempts: 0,
    });
    expect(JSON.stringify(sources)).not.toContain('must-not-leak');
  });
});
