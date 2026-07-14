import { describe, expect, it } from 'vitest';

import { ProbeObserver } from '../src/reliability/probe-observer.js';
import { ProbeReceiptStore } from '../src/reliability/probe-receipt-store.js';

const probe = {
  isSynthetic: true as const,
  probeId: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
  attemptId: '01J2Z9M77A68K8B1T4W5F6H9P0',
};

describe('ProbeObserver', () => {
  it('adds bot identity and records execution metadata without content', () => {
    const store = new ProbeReceiptStore();
    const observer = new ProbeObserver(store, 'marketing-bot');
    observer.stage(probe, {
      stage: 'run_completed',
      at: '2026-07-14T00:00:00Z',
      sessionId: 'session-1',
      model: 'claude-opus-4-8',
      backend: 'pty',
    });
    expect(store.getAttempt(probe.probeId, probe.attemptId)?.stages).toEqual([{
      stage: 'run_completed',
      at: '2026-07-14T00:00:00Z',
      botName: 'marketing-bot',
      sessionId: 'session-1',
      model: 'claude-opus-4-8',
      backend: 'pty',
    }]);
  });

  it('never emits file_delivered for a failed upload or send', () => {
    const store = new ProbeReceiptStore();
    const observer = new ProbeObserver(store, 'marketing-bot');
    observer.delivery(probe, { ok: false, kind: 'file', fileName: 'report.pdf' });
    observer.delivery(probe, {
      ok: true, kind: 'file', fileName: 'report.pdf', fileKey: 'fk', messageId: 'om',
    });
    expect(store.getAttempt(probe.probeId, probe.attemptId)?.stages).toEqual([
      {
        stage: 'failed', at: expect.any(String), botName: 'marketing-bot',
        fileName: 'report.pdf', errorClass: 'feishu_deliver',
      },
      {
        stage: 'file_delivered', at: expect.any(String), botName: 'marketing-bot',
        fileName: 'report.pdf', fileKey: 'fk', messageId: 'om',
      },
    ]);
  });
});
