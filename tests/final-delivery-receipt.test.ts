import { expect, it, vi } from 'vitest';

import { sendFinalCardWithRetry } from '../src/bridge/final-delivery.js';

it('reports whether the final card was actually updated', async () => {
  const success = await sendFinalCardWithRetry({
    sender: { updateCard: vi.fn().mockResolvedValue(true) } as never,
    config: {} as never,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
    sessionManager: {} as never,
    messageId: 'om_out',
    state: { status: 'complete', userPrompt: '', responseText: 'ok', toolCalls: [] },
  });
  expect(success).toBe(true);
});
