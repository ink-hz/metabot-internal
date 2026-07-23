import { describe, expect, it, vi } from 'vitest';
import type { FlywheelEventEnvelope } from '../src/flywheel/envelope.js';
import { FlywheelQueue } from '../src/flywheel/queue.js';
import { createFlywheelRecorder } from '../src/flywheel/index.js';
import { metrics } from '../src/utils/metrics.js';

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
    recorder.recordFeedbackReceived({} as any);
    recorder.recordIdentityObserved({} as any);
    expect(writerFactory).not.toHaveBeenCalled();
  });

  it('queues a content-free sender identity observation', async () => {
    const writer = { write: vi.fn(async () => 'committed' as const), close: vi.fn() };
    const recorder = createFlywheelRecorder({
      env: enabledEnv(), logger: { warn: vi.fn() } as any, writerFactory: () => writer,
    });

    recorder.recordIdentityObserved({
      botId: 'hr-bot',
      turnId: '70000000-0000-4000-8000-000000000004',
      runId: null,
      sender: {
        provider: 'feishu', union_id: 'on_sender', open_id: 'ou_sender', display_name: 'Lina',
        attributes: { source: 'feishu_chat_members' },
      },
      conversation: { platform: 'feishu', platform_id: 'identity-chat', type: 'direct' },
      payload: {},
    });
    await recorder.flush();

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'identity_observed',
      sender: expect.objectContaining({ display_name: 'Lina' }),
      payload: {},
    }));
    expect(JSON.stringify(writer.write.mock.calls[0][0])).not.toContain('message content');
    await recorder.close();
  });

  it('queues a typed feedback event after removing private thinking structures', async () => {
    const writer = { write: vi.fn(async () => 'committed' as const), close: vi.fn() };
    const recorder = createFlywheelRecorder({
      env: enabledEnv(),
      logger: { warn: vi.fn() } as any,
      writerFactory: () => writer,
    });

    recorder.recordFeedbackReceived({
      botId: 'marketing-intelligence-bot',
      turnId: '70000000-0000-4000-8000-000000000001',
      runId: null,
      conversation: { platform: 'feishu', platform_id: 'feedback-chat', type: 'direct' },
      payload: {
        kind: 'correction',
        raw_text: '请改成按区域汇总。',
        ability_key: 'market_analysis',
        private_trace: { type: 'thinking', text: 'must not persist' },
      },
    });
    await recorder.flush();

    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.write.mock.calls[0][0]).toMatchObject({
      event_type: 'feedback_received',
      bot_id: 'marketing-intelligence-bot',
      business_domain: 'marketing_intelligence',
      payload: {
        kind: 'correction',
        raw_text: '请改成按区域汇总。',
        ability_key: 'market_analysis',
      },
    });
    expect(JSON.stringify(writer.write.mock.calls[0][0])).not.toContain('must not persist');
    await recorder.close();
  });

  it('rejects credential-bearing feedback before it reaches the writer', async () => {
    const writer = { write: vi.fn(async () => 'committed' as const), close: vi.fn() };
    const logger = { warn: vi.fn() };
    const counter = vi.spyOn(metrics, 'incCounter');
    const recorder = createFlywheelRecorder({
      env: enabledEnv(), logger: logger as any, writerFactory: () => writer,
    });

    recorder.recordFeedbackReceived({
      botId: 'hr-bot',
      turnId: '70000000-0000-4000-8000-000000000002',
      runId: null,
      conversation: { platform: 'feishu', platform_id: 'credential-chat', type: 'direct' },
      payload: { kind: 'correction', raw_text: 'Bearer abc.def-123' },
    });
    await recorder.flush();

    expect(writer.write).not.toHaveBeenCalled();
    expect(counter).toHaveBeenCalledWith('flywheel_events_rejected_total');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('abc.def-123');
    counter.mockRestore();
    await recorder.close();
  });

  it('drops an unknown Bot without logging its ID or payload', async () => {
    const writer = { write: vi.fn(async () => 'committed' as const), close: vi.fn() };
    const logger = { warn: vi.fn() };
    const recorder = createFlywheelRecorder({
      env: enabledEnv(), logger: logger as any, writerFactory: () => writer,
    });

    recorder.recordMessageReceived({
      botId: 'unknown-sensitive-bot-id',
      turnId: '70000000-0000-4000-8000-000000000003',
      runId: null,
      conversation: { platform: 'feishu', platform_id: 'unknown-chat', type: 'direct' },
      payload: { content: 'unknown-sensitive-payload' },
    });
    await recorder.flush();

    expect(writer.write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { error_class: 'UnknownFlywheelBotError' },
      'Flywheel event rejected',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('unknown-sensitive');
    await recorder.close();
  });
});

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    FLYWHEEL_ENABLED: 'true',
    FLYWHEEL_DATABASE_URL: 'postgresql://flywheel_ingest@127.0.0.1/flywheel',
    FLYWHEEL_RETRY_BASE_MS: '1',
  };
}
