import { describe, expect, it, vi } from 'vitest';
import type { FlywheelEventEnvelope } from '../src/flywheel/envelope.js';
import { FlywheelQueue } from '../src/flywheel/queue.js';
import { createFlywheelRecorder } from '../src/flywheel/index.js';

const event = (): FlywheelEventEnvelope => ({
  event_id: crypto.randomUUID(), event_type: 'tool_call', seq: 1,
  recorder_instance: crypto.randomUUID(), occurred_at: new Date().toISOString(),
  bot_id: 'hr-bot', business_domain: 'hr', turn_id: crypto.randomUUID(), run_id: crypto.randomUUID(),
  conversation: { platform: 'feishu', platform_id: 'chat', type: 'direct' }, payload: { marker: 'must-not-log' },
});

describe('flywheel queue', () => {
  it('drops on overflow and logs only the safe gap identity', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writer = { write: vi.fn(async () => { await blocked; return 'committed' as const; }), close: vi.fn() };
    const logger = { warn: vi.fn() } as any;
    const counters = { incCounter: vi.fn() };
    const queue = new FlywheelQueue(writer, logger, counters, { capacity: 1, batchSize: 1, timeoutMs: 2000, maxAttempts: 3 });

    expect(queue.enqueue(event())).toBe(true);
    expect(queue.enqueue(event())).toBe(false);
    expect(counters.incCounter).toHaveBeenCalledWith('flywheel_events_dropped_total');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('must-not-log');
    release();
    await queue.flush();
  });

  it('tries a failed write three times then drops it', async () => {
    const writer = { write: vi.fn(async () => { throw new Error('database unavailable'); }), close: vi.fn() };
    const logger = { warn: vi.fn() } as any;
    const counters = { incCounter: vi.fn() };
    const queue = new FlywheelQueue(writer, logger, counters, { capacity: 10, batchSize: 5, timeoutMs: 50, maxAttempts: 3, retryBaseMs: 1 });
    queue.enqueue(event());
    await queue.flush();
    expect(writer.write).toHaveBeenCalledTimes(3);
    expect(counters.incCounter).toHaveBeenCalledWith('flywheel_events_dropped_total');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('database unavailable');
  });
});

describe('flywheel recorder feature flag', () => {
  it('is a connection-free no-op when disabled or absent', () => {
    const writerFactory = vi.fn();
    const recorder = createFlywheelRecorder({ env: {}, logger: { warn: vi.fn() } as any, writerFactory });
    recorder.recordMessageReceived({} as any);
    recorder.recordRunStarted({} as any);
    recorder.recordToolCall({} as any);
    recorder.recordRunCompleted({} as any);
    recorder.recordRunFailed({} as any);
    recorder.recordEvidence({} as any);
    expect(writerFactory).not.toHaveBeenCalled();
  });
});
