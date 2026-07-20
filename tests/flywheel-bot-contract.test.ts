import { describe, expect, it } from 'vitest';
import {
  FLYWHEEL_BUSINESS_DOMAINS,
  UnknownFlywheelBotError,
  businessDomainForBot,
} from '../src/flywheel/index.js';

describe('Flywheel current Bot identity contract', () => {
  it('contains exactly the nine formal Bot/domain pairs', () => {
    expect(FLYWHEEL_BUSINESS_DOMAINS).toEqual({
      'feishu-default': 'general',
      'hr-bot': 'hr',
      'marketing-prospecting-bot': 'marketing_prospecting',
      'marketing-inbound-bot': 'marketing_inbound',
      'marketing-voice-bot': 'marketing_voice',
      'marketing-intelligence-bot': 'marketing_intelligence',
      'marketing-gtm-bot': 'marketing_gtm',
      'fae-bot': 'fae',
      'test-bot': 'test',
    });
    expect(Object.isFrozen(FLYWHEEL_BUSINESS_DOMAINS)).toBe(true);
    for (const [botId, domain] of Object.entries(FLYWHEEL_BUSINESS_DOMAINS)) {
      expect(businessDomainForBot(botId)).toBe(domain);
    }
  });

  it.each(['marketing-bot', 'pc-bot', 'quality-bot', '', 'arbitrary-bot'])
  ('rejects non-current Bot ID %j without a general fallback', (botId) => {
    expect(() => businessDomainForBot(botId)).toThrow(UnknownFlywheelBotError);
    expect(() => businessDomainForBot(botId)).toThrow('UnknownFlywheelBotError');
  });
});
