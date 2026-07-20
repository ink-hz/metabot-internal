import { describe, expect, it } from 'vitest';
import { EventEnvelopeFactory, FLYWHEEL_EVENT_TYPES } from '../src/flywheel/envelope.js';

describe('flywheel event envelope', () => {
  it('includes the typed explicit-feedback event', () => {
    expect(FLYWHEEL_EVENT_TYPES).toContain('feedback_received');
  });

  it('assigns a stable recorder instance and monotonic sequence', () => {
    const factory = new EventEnvelopeFactory('00000000-0000-4000-8000-000000000001');
    const first = factory.create(baseInput('message_received'));
    const second = factory.create(baseInput('run_started'));
    expect(first.recorder_instance).toBe(second.recorder_instance);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('tracks sequence independently per bot so gap scans do not see interleaving as loss', () => {
    const factory = new EventEnvelopeFactory();
    const hr1 = factory.create(baseInput('message_received'));
    const fae1 = factory.create({ ...baseInput('message_received'), botId: 'fae-bot', businessDomain: 'fae' });
    const hr2 = factory.create(baseInput('tool_call'));
    expect([hr1.seq, fae1.seq, hr2.seq]).toEqual([1, 1, 2]);
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
      is_synthetic: false,
      probe_id: null,
    });
    expect(envelope.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.occurred_at).toMatch(/T/);
  });

  it('propagates trusted synthetic identity at the top level', () => {
    const envelope = new EventEnvelopeFactory().create({
      ...baseInput('message_received'),
      isSynthetic: true,
      probeId: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
    });
    expect(envelope).toMatchObject({
      is_synthetic: true,
      probe_id: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
    });
  });
});

function baseInput(eventType: (typeof FLYWHEEL_EVENT_TYPES)[number]) {
  return {
    eventType,
    botId: 'hr-bot',
    businessDomain: 'hr',
    turnId: '10000000-0000-4000-8000-000000000001',
    runId: ['message_received', 'feedback_received'].includes(eventType)
      ? null
      : '20000000-0000-4000-8000-000000000002',
    sender: { provider: 'feishu' as const, union_id: 'union-1', open_id: 'open-1' },
    conversation: { platform: 'feishu' as const, platform_id: 'chat-1', type: 'direct' as const },
    payload: { content: '完整正文' },
  };
}
