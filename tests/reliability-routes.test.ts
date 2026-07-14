import { describe, expect, it } from 'vitest';

import { handleReliabilityRoutes } from '../src/api/routes/reliability-routes.js';
import { ProbeReceiptStore } from '../src/reliability/probe-receipt-store.js';

const probe = {
  isSynthetic: true as const,
  probeId: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
  attemptId: '01J2Z9M77A68K8B1T4W5F6H9P0',
};

function responseRecorder() {
  const state: { status?: number; body?: any } = {};
  return {
    state,
    response: {
      writeHead(status: number) { state.status = status; },
      end(body: string) { state.body = JSON.parse(body); },
    } as never,
  };
}

describe('handleReliabilityRoutes', () => {
  it('returns one exact attempt without content fields', async () => {
    const store = new ProbeReceiptStore();
    store.record(probe, { stage: 'feishu_received', at: '2026-07-14T00:00:00Z', messageId: 'om_in' });
    const { response, state } = responseRecorder();

    const handled = await handleReliabilityRoutes(
      { probeReceiptStore: store } as never,
      {} as never,
      response,
      'GET',
      `/api/reliability/probes/${probe.probeId}?attempt_id=${probe.attemptId}`,
    );

    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ probeId: probe.probeId, attemptId: probe.attemptId });
    expect(JSON.stringify(state.body)).not.toMatch(/content|prompt|token/iu);
  });

  it('returns 404 for an unknown probe and 400 for malformed identifiers', async () => {
    const store = new ProbeReceiptStore();
    const unknown = responseRecorder();
    await handleReliabilityRoutes(
      { probeReceiptStore: store } as never, {} as never, unknown.response,
      'GET', `/api/reliability/probes/${probe.probeId}`,
    );
    expect(unknown.state.status).toBe(404);

    const malformed = responseRecorder();
    await handleReliabilityRoutes(
      { probeReceiptStore: store } as never, {} as never, malformed.response,
      'GET', '/api/reliability/probes/not-an-id',
    );
    expect(malformed.state.status).toBe(400);
  });

  it('does not claim unrelated paths', async () => {
    const { response } = responseRecorder();
    await expect(handleReliabilityRoutes(
      { probeReceiptStore: new ProbeReceiptStore() } as never,
      {} as never,
      response,
      'GET',
      '/api/status',
    )).resolves.toBe(false);
  });
});
