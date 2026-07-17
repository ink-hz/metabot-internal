import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncQueue } from '../src/utils/async-queue.js';
import type {
  GatewayTurnLease,
  GatewayTurnLeaseHandle,
} from '../src/engines/claude/pty/gateway-turn-lease.js';
import type { PtyHookBridge, PtyUserMessage } from '../src/engines/claude/pty/contract.js';

const harness = vi.hoisted(() => ({
  events: [] as string[],
  onExit: undefined as undefined | ((info: { exitCode: number; signal?: number }) => void),
  stopScanner: false,
  records: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/engines/claude/pty/pty-session.js', () => ({
  createPtyClaudeSession: (options: { onExit?: (info: { exitCode: number; signal?: number }) => void }) => {
    harness.onExit = options.onExit;
    return {
      sessionId: 'session-test',
      jsonlPath: '/tmp/metabot-lease-test-missing.jsonl',
      typePrompt: async () => { harness.events.push('typePrompt'); },
      sendKeys: () => {},
      snapshot: () => '',
      screen: () => '',
      interrupt: async () => { harness.events.push('session:interrupt'); },
      dispose: async () => { harness.events.push('session:dispose'); },
    };
  },
}));

vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: () => ({
    stop: () => { harness.stopScanner = true; },
    async *[Symbol.asyncIterator]() {
      while (!harness.stopScanner) {
        const record = harness.records.shift();
        if (record) yield record;
        else await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  }),
}));

import { ptyQuery } from '../src/engines/claude/pty/pty-query.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
const waitUntil = async (predicate: () => boolean, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function prompt(): PtyUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: '介绍下自己' },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function hookBridge(): { bridge: PtyHookBridge; complete: () => void } {
  let completion = () => {};
  return {
    bridge: {
      writeSettings: async () => '/tmp/settings.json',
      onTurnComplete: (callback) => { completion = callback; },
      onTeamEvent: () => {},
      dispose: async () => {},
    },
    complete: () => completion(),
  };
}

function controlledLease(): {
  lease: GatewayTurnLease;
  allow: () => void;
  releases: () => number;
} {
  let resolveAcquire: ((handle: GatewayTurnLeaseHandle) => void) | undefined;
  let releaseCount = 0;
  const handle = { release: async () => { releaseCount += 1; harness.events.push('release'); } };
  return {
    lease: {
      acquire: async () => {
        harness.events.push('acquire:start');
        return new Promise<GatewayTurnLeaseHandle>((resolve) => { resolveAcquire = resolve; });
      },
    },
    allow: () => { harness.events.push('acquire:done'); resolveAcquire?.(handle); },
    releases: () => releaseCount,
  };
}

beforeEach(() => {
  harness.events.length = 0;
  harness.onExit = undefined;
  harness.stopScanner = false;
  harness.records.length = 0;
});

describe('ptyQuery gateway turn lease lifecycle', () => {
  it('waits for the lease before dispatch and releases on Stop completion', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks = hookBridge();
    const gateway = controlledLease();
    const query = ptyQuery({
      prompt: input,
      options: { cwd: '/tmp', logger, hookBridge: hooks.bridge, gatewayTurnLease: gateway.lease },
    });

    input.enqueue(prompt());
    await waitUntil(() => harness.events.includes('acquire:start'));
    expect(harness.events).not.toContain('typePrompt');
    gateway.allow();
    await waitUntil(() => harness.events.includes('typePrompt'));
    hooks.complete();
    await waitUntil(() => gateway.releases() === 1);
    expect(harness.events).toEqual(['acquire:start', 'acquire:done', 'typePrompt', 'release']);
    await query.dispose?.();
    expect(gateway.releases()).toBe(1);
  });

  it('releases exactly once when Claude exits during a dispatched turn', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks = hookBridge();
    let releases = 0;
    const query = ptyQuery({
      prompt: input,
      options: {
        cwd: '/tmp', logger, hookBridge: hooks.bridge,
        gatewayTurnLease: { acquire: async () => ({ release: async () => { releases += 1; } }) },
      },
    });
    input.enqueue(prompt());
    await waitUntil(() => harness.events.includes('typePrompt'));
    harness.onExit?.({ exitCode: 1 });
    await waitUntil(() => releases === 1);
    await query.dispose?.();
    expect(releases).toBe(1);
  });

  it('releases when a terminal gateway API error ends the turn without a Stop hook', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks = hookBridge();
    let releases = 0;
    const query = ptyQuery({
      prompt: input,
      options: {
        cwd: '/tmp', logger, hookBridge: hooks.bridge,
        gatewayTurnLease: { acquire: async () => ({ release: async () => { releases += 1; } }) },
      },
    });
    input.enqueue(prompt());
    await waitUntil(() => harness.events.includes('typePrompt'));
    harness.records.push({
      type: 'assistant',
      isApiErrorMessage: true,
      parentToolUseID: null,
      apiErrorStatus: 429,
    });

    await waitUntil(() => releases === 1);
    await query.dispose?.();
    expect(releases).toBe(1);
  });

  it('releases an active turn during explicit disposal', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks = hookBridge();
    let releases = 0;
    const query = ptyQuery({
      prompt: input,
      options: {
        cwd: '/tmp', logger, hookBridge: hooks.bridge,
        gatewayTurnLease: { acquire: async () => ({ release: async () => { releases += 1; } }) },
      },
    });
    input.enqueue(prompt());
    await waitUntil(() => harness.events.includes('typePrompt'));

    await query.dispose?.();

    expect(releases).toBe(1);
  });

  it('interrupts a queued turn without submitting it or disturbing an owner', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks = hookBridge();
    const lease: GatewayTurnLease = {
      acquire: async ({ cancelled = () => false } = {}) => {
        harness.events.push('acquire:start');
        while (!cancelled()) await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('gateway turn lease acquisition cancelled');
      },
    };
    const query = ptyQuery({
      prompt: input,
      options: { cwd: '/tmp', logger, hookBridge: hooks.bridge, gatewayTurnLease: lease },
    });
    const iterator = query[Symbol.asyncIterator]();
    input.enqueue(prompt());
    await waitUntil(() => harness.events.includes('acquire:start'));
    await query.interrupt();

    const terminal = await iterator.next();
    expect(terminal.value).toMatchObject({ type: 'result', subtype: 'error' });
    expect(harness.events).not.toContain('typePrompt');
    await query.dispose?.();
  });
});
