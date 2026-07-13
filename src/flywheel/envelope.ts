import { randomUUID } from 'node:crypto';

export const FLYWHEEL_EVENT_TYPES = [
  'message_received', 'run_started', 'tool_call',
  'run_completed', 'run_failed', 'evidence',
] as const;

export type FlywheelEventType = (typeof FLYWHEEL_EVENT_TYPES)[number];

export interface FlywheelSender {
  provider: 'feishu';
  union_id?: string;
  open_id?: string;
  display_name?: string;
  department?: string;
  attributes?: Record<string, unknown>;
}

export interface FlywheelConversation {
  platform: 'feishu';
  platform_id: string;
  type: 'direct' | 'group';
}

export interface FlywheelEventEnvelope {
  event_id: string;
  event_type: FlywheelEventType;
  seq: number;
  recorder_instance: string;
  occurred_at: string;
  bot_id: string;
  business_domain: string;
  turn_id: string;
  run_id: string | null;
  sender?: FlywheelSender;
  conversation: FlywheelConversation;
  payload: Record<string, unknown>;
}

export interface EventEnvelopeInput {
  eventType: FlywheelEventType;
  botId: string;
  businessDomain: string;
  turnId: string;
  runId?: string | null;
  sender?: FlywheelSender;
  conversation: FlywheelConversation;
  payload: Record<string, unknown>;
  occurredAt?: string;
  eventId?: string;
}

export class EventEnvelopeFactory {
  private seq = 0;

  constructor(private readonly recorderInstance = randomUUID()) {}

  create(input: EventEnvelopeInput): FlywheelEventEnvelope {
    return {
      event_id: input.eventId ?? randomUUID(),
      event_type: input.eventType,
      seq: ++this.seq,
      recorder_instance: this.recorderInstance,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      bot_id: input.botId,
      business_domain: input.businessDomain,
      turn_id: input.turnId,
      run_id: input.runId ?? null,
      ...(input.sender ? { sender: input.sender } : {}),
      conversation: input.conversation,
      payload: input.payload,
    };
  }
}
