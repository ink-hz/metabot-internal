import { describe, expect, it } from 'vitest';
import { EventEnvelopeFactory, FLYWHEEL_EVENT_TYPES } from '../src/flywheel/envelope.js';

describe('flywheel event envelope', () => {
  it('assigns a stable recorder instance and monotonic sequence', () => {
    const factory = new EventEnvelopeFactory('00000000-0000-4000-8000-000000000001');
    const first = factory.create(baseInput('message_received'));
    const second = factory.create(baseInput('run_started'));
    expect(first.recorder_instance).toBe(second.recorder_instance);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it.each(FLYWHEEL_EVENT_TYPES)('builds a complete %s envelope', (eventType) => {
    const envelope = new EventEnvelopeFactory().create(baseInput(eventType));
    expect(envelope).toMatchObject({
      event_type: eventType,
      bot_id: 'hr-bot',
      business_domain: 'hr',
      turn_id: '10000000-0000-4000-8000-000000000001',
      conversation: { platform: 'feishu', platform_id: 'chat-1', type: 'direct' },
      payload: { content: '完整正文' },
    });
    expect(envelope.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.occurred_at).toMatch(/T/);
  });
});

function baseInput(eventType: (typeof FLYWHEEL_EVENT_TYPES)[number]) {
  return {
    eventType,
    botId: 'hr-bot',
    businessDomain: 'hr',
    turnId: '10000000-0000-4000-8000-000000000001',
    runId: eventType === 'message_received' ? null : '20000000-0000-4000-8000-000000000002',
    sender: { provider: 'feishu' as const, union_id: 'union-1', open_id: 'open-1' },
    conversation: { platform: 'feishu' as const, platform_id: 'chat-1', type: 'direct' as const },
    payload: { content: '完整正文' },
  };
}
