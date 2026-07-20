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

export const FLYWHEEL_BUSINESS_DOMAINS = Object.freeze({
  'feishu-default': 'general',
  'hr-bot': 'hr',
  'marketing-prospecting-bot': 'marketing_prospecting',
  'marketing-inbound-bot': 'marketing_inbound',
  'marketing-voice-bot': 'marketing_voice',
  'marketing-intelligence-bot': 'marketing_intelligence',
  'marketing-gtm-bot': 'marketing_gtm',
  'fae-bot': 'fae',
  'test-bot': 'test',
} as const);

export class UnknownFlywheelBotError extends Error {
  constructor() {
    super('UnknownFlywheelBotError');
    this.name = 'UnknownFlywheelBotError';
  }
}

export function businessDomainForBot(botId: string): string {
  if (!Object.hasOwn(FLYWHEEL_BUSINESS_DOMAINS, botId)) {
    throw new UnknownFlywheelBotError();
  }
  return FLYWHEEL_BUSINESS_DOMAINS[botId as keyof typeof FLYWHEEL_BUSINESS_DOMAINS];
}

export type RecordEventInput = Omit<EventEnvelopeInput, 'eventType' | 'businessDomain'>;

export interface FlywheelRecorder {
  recordMessageReceived(input: RecordEventInput): void;
  recordRunStarted(input: RecordEventInput): void;
  recordToolCall(input: RecordEventInput): void;
  recordRunCompleted(input: RecordEventInput): void;
  recordRunFailed(input: RecordEventInput): void;
  recordEvidence(input: RecordEventInput): void;
  recordFeedbackReceived(input: RecordEventInput): void;
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
  recordRunCompleted() {}, recordRunFailed() {}, recordEvidence() {}, recordFeedbackReceived() {},
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
    let businessDomain: string;
    try {
      businessDomain = businessDomainForBot(input.botId);
    } catch (error) {
      metrics.incCounter('flywheel_events_rejected_total');
      metrics.incCounter('flywheel_events_dropped_total');
      options.logger.warn({ error_class: error instanceof Error ? error.name : 'FlywheelBotContractError' },
        'Flywheel event rejected');
      return;
    }
    if (redactor.containsSensitive(input)) {
      metrics.incCounter('flywheel_events_rejected_total');
      metrics.incCounter('flywheel_events_dropped_total');
      options.logger.warn({ error_class: 'SensitiveFlywheelEventError' }, 'Flywheel event rejected');
      return;
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
    recordFeedbackReceived: (input) => record('feedback_received', input),
    flush: () => queue.flush(),
    close: () => queue.close(),
  };
}
