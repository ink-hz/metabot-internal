import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { handleTaskRoutes } from '../src/api/routes/task-routes.js';

const PROBE_ID = '01J2Z9K2E8F5G9M6W4Q3T7R8Y1';
const ATTEMPT_ID = '01J2Z9M77A68K8B1T4W5F6H9P0';

function request(body: unknown): any {
  const req = new EventEmitter() as any;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; },
    end(body: string) { this.body = body; },
  };
}

function context(executeApiTask: ReturnType<typeof vi.fn>): any {
  return {
    registry: { get: () => ({ bridge: { executeApiTask } }) },
    scheduler: {},
    logger: { info: vi.fn(), error: vi.fn() },
    asyncTaskStore: {},
    circuitBreaker: {
      isAvailable: () => true,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    },
    budgetManager: {
      canAcceptTask: () => ({ allowed: true }),
      recordCost: vi.fn(),
    },
    ws: {},
  };
}

describe('task route reliability probe', () => {
  it('passes a strict authenticated probe identity to local API execution', async () => {
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'ok',
    }));
    const res = response();

    await handleTaskRoutes(
      context(executeApiTask),
      request({
        botName: 'hr-bot',
        chatId: 'oc_canary',
        prompt: 'private prompt',
        sendCards: false,
        deliveryChatId: 'oc_delivery_canary',
        syntheticProbe: { probeId: PROBE_ID, attemptId: ATTEMPT_ID },
      }),
      res,
      'POST',
      '/api/talk',
    );

    expect(res.statusCode).toBe(200);
    expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
      syntheticProbe: {
        isSynthetic: true,
        probeId: PROBE_ID,
        attemptId: ATTEMPT_ID,
      },
      deliveryChatId: 'oc_delivery_canary',
    }));
  });

  it('rejects a supplied malformed probe instead of running it as real traffic', async () => {
    const executeApiTask = vi.fn();
    const res = response();

    await handleTaskRoutes(
      context(executeApiTask),
      request({
        botName: 'hr-bot',
        chatId: 'oc_canary',
        prompt: 'private prompt',
        syntheticProbe: { probeId: 'bad', attemptId: ATTEMPT_ID },
      }),
      res,
      'POST',
      '/api/talk',
    );

    expect(res.statusCode).toBe(400);
    expect(executeApiTask).not.toHaveBeenCalled();
  });

  it('rejects a separate delivery chat for non-synthetic traffic', async () => {
    const executeApiTask = vi.fn();
    const res = response();

    await handleTaskRoutes(
      context(executeApiTask),
      request({
        botName: 'hr-bot',
        chatId: 'real-user-chat',
        deliveryChatId: 'other-chat',
        prompt: 'private prompt',
      }),
      res,
      'POST',
      '/api/talk',
    );

    expect(res.statusCode).toBe(400);
    expect(executeApiTask).not.toHaveBeenCalled();
  });
});
