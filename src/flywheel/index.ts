import type { Logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { loadFlywheelConfig } from './config.js';
import {
  EventEnvelopeFactory,
  type EventEnvelopeInput,
  type FlywheelEventType,
} from './envelope.js';
import { FlywheelQueue } from './queue.js';
import { collectKnownSecrets, createRedactor } from './redactor.js';
import { PgFlywheelWriter, type FlywheelWriter } from './writer.js';

const BUSINESS_DOMAINS: Record<string, string> = {
  'feishu-default': 'general',
  'hr-bot': 'hr',
  'marketing-bot': 'marketing',
  'pc-bot': 'product-commercialization',
  'quality-bot': 'quality',
  'fae-bot': 'fae',
};

export type RecordEventInput = Omit<EventEnvelopeInput, 'eventType' | 'businessDomain'>;

export interface FlywheelRecorder {
  recordMessageReceived(input: RecordEventInput): void;
  recordRunStarted(input: RecordEventInput): void;
  recordToolCall(input: RecordEventInput): void;
  recordRunCompleted(input: RecordEventInput): void;
  recordRunFailed(input: RecordEventInput): void;
  recordEvidence(input: RecordEventInput): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface RecorderOptions {
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  knownSecrets?: string[];
  writerFactory?: (databaseUrl: string) => FlywheelWriter;
}

const NOOP_RECORDER: FlywheelRecorder = {
  recordMessageReceived() {}, recordRunStarted() {}, recordToolCall() {},
  recordRunCompleted() {}, recordRunFailed() {}, recordEvidence() {},
  async flush() {}, async close() {},
};

export function createFlywheelRecorder(options: RecorderOptions): FlywheelRecorder {
  const env = options.env ?? process.env;
  const config = loadFlywheelConfig(env);
  if (!config.enabled) return NOOP_RECORDER;
  if (!config.databaseUrl) return NOOP_RECORDER;

  let writer: FlywheelWriter;
  try {
    writer = (options.writerFactory ?? ((url) => new PgFlywheelWriter(url)))(config.databaseUrl);
  } catch {
    return NOOP_RECORDER;
  }

  const queue = new FlywheelQueue(writer, options.logger, metrics, {
    capacity: config.queueCapacity,
    batchSize: config.batchSize,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
  });
  const factory = new EventEnvelopeFactory();
  const redactor = createRedactor([...collectKnownSecrets(env), ...(options.knownSecrets ?? [])]);

  const record = (eventType: FlywheelEventType, input: RecordEventInput): void => {
    const businessDomain = BUSINESS_DOMAINS[input.botId] ?? 'general';
    if (!(input.botId in BUSINESS_DOMAINS)) {
      metrics.incCounter('flywheel_events_rejected_total');
      options.logger.warn({ bot_id: input.botId, event_type: eventType, failure_category: 'unknown_bot' },
        'Flywheel event uses general domain');
    }
    const clean = redactor.sanitize(factory.create({ ...input, eventType, businessDomain }));
    if (!clean) {
      metrics.incCounter('flywheel_events_rejected_total');
      return;
    }
    queue.enqueue(clean);
  };

  return {
    recordMessageReceived: (input) => record('message_received', input),
    recordRunStarted: (input) => record('run_started', input),
    recordToolCall: (input) => record('tool_call', input),
    recordRunCompleted: (input) => record('run_completed', input),
    recordRunFailed: (input) => record('run_failed', input),
    recordEvidence: (input) => record('evidence', input),
    flush: () => queue.flush(),
    close: () => queue.close(),
  };
}
