import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProbeReceiptStore } from '../src/reliability/probe-receipt-store.js';

const first = {
  isSynthetic: true as const,
  probeId: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
  attemptId: '01J2Z9M77A68K8B1T4W5F6H9P0',
};

describe('ProbeReceiptStore', () => {
  afterEach(() => vi.useRealTimers());

  it('stores allowlisted stages and expires them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00Z'));
    const store = new ProbeReceiptStore({ ttlMs: 1000, maxProbes: 2 });
    store.record(first, {
      stage: 'feishu_received',
      at: new Date().toISOString(),
      botName: 'hr-bot',
      messageId: 'om_in',
    });

    expect(store.getAttempt(first.probeId, first.attemptId)).toEqual({
      probeId: first.probeId,
      attemptId: first.attemptId,
      stages: [{
        stage: 'feishu_received',
        at: '2026-07-14T00:00:00.000Z',
        botName: 'hr-bot',
        messageId: 'om_in',
      }],
    });

    vi.advanceTimersByTime(1001);
    expect(store.getAttempt(first.probeId, first.attemptId)).toBeUndefined();
  });

  it('keeps retry attempts separate under one probe', () => {
    const store = new ProbeReceiptStore({ ttlMs: 1000, maxProbes: 2 });
    const retry = { ...first, attemptId: '01J2Z9N8VQ7D2C6X5B4A3M1K0H' };
    store.record(first, { stage: 'failed', at: new Date().toISOString(), errorClass: 'gateway_transport' });
    store.record(retry, { stage: 'feishu_received', at: new Date().toISOString(), messageId: 'om_retry' });

    expect(store.get(first.probeId)?.attempts.map(({ attemptId }) => attemptId)).toEqual([
      first.attemptId,
      retry.attemptId,
    ]);
    expect(store.getAttempt(first.probeId, first.attemptId)?.stages[0].stage).toBe('failed');
    expect(store.getAttempt(first.probeId, retry.attemptId)?.stages[0].stage).toBe('feishu_received');
  });

  it('rejects free-form content fields', () => {
    const store = new ProbeReceiptStore({ ttlMs: 1000, maxProbes: 2 });
    expect(() => store.record(first, {
      stage: 'failed',
      at: new Date().toISOString(),
      content: 'secret prompt',
    } as never)).toThrow(/unsupported receipt field: content/);
  });

  it('evicts the oldest probe when capacity is exceeded', () => {
    const store = new ProbeReceiptStore({ ttlMs: 1000, maxProbes: 1 });
    store.record(first, { stage: 'feishu_received', at: new Date().toISOString() });
    const second = {
      ...first,
      probeId: '01J2Z9P9C8V7B6N5M4K3J2H1G0',
    };
    store.record(second, { stage: 'feishu_received', at: new Date().toISOString() });
    expect(store.get(first.probeId)).toBeUndefined();
    expect(store.get(second.probeId)).toBeDefined();
  });
});
