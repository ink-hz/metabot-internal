import { describe, expect, it } from 'vitest';
import {
  buildProviderStreamDryRunReport,
  evaluateProviderStreamLifetime,
} from '../scripts/verify-provider-stream-lifetime.js';
import { resolveClaudeApiTimeoutSettings } from '../src/engines/claude/compatibility/timeout-policy.js';

describe('provider stream lifetime rollout gate', () => {
  it('keeps the explicit provider timeout at 300 seconds by default', () => {
    expect(resolveClaudeApiTimeoutSettings({})).toEqual({ API_TIMEOUT_MS: '300000' });
  });

  it('allows 600 seconds only with an explicit verified-stream contract', () => {
    expect(() => resolveClaudeApiTimeoutSettings({
      METABOT_CLAUDE_API_TIMEOUT_MS: '600000',
    })).toThrow(/stream lifetime verification/i);
    expect(resolveClaudeApiTimeoutSettings({
      METABOT_CLAUDE_API_TIMEOUT_MS: '600000',
      METABOT_PROVIDER_STREAM_LIFETIME_VERIFIED: 'true',
    })).toEqual({ API_TIMEOUT_MS: '600000' });
    expect(() => resolveClaudeApiTimeoutSettings({
      METABOT_CLAUDE_API_TIMEOUT_MS: '900000',
      METABOT_PROVIDER_STREAM_LIFETIME_VERIFIED: 'true',
    })).toThrow(/300000 or 600000/);
  });

  it('passes only evidence that reached the required lifetime', () => {
    expect(evaluateProviderStreamLifetime({
      requiredLifetimeMs: 600_000,
      observedDurationMs: 600_001,
      maxIdleGapMs: 59_000,
      endedEarly: false,
    })).toMatchObject({ passed: true, heartbeatWithinContract: true });
    expect(evaluateProviderStreamLifetime({
      requiredLifetimeMs: 600_000,
      observedDurationMs: 600_001,
      maxIdleGapMs: 120_000,
      endedEarly: false,
    })).toMatchObject({ passed: true, heartbeatWithinContract: false });
    expect(evaluateProviderStreamLifetime({
      requiredLifetimeMs: 600_000,
      observedDurationMs: 244_000,
      maxIdleGapMs: 244_000,
      endedEarly: true,
    }).passed).toBe(false);
  });

  it('builds a dry-run report without accepting or exposing credentials', () => {
    const report = buildProviderStreamDryRunReport();
    expect(report).toEqual({
      mode: 'dry-run',
      requiredLifetimeMs: 600_000,
      heartbeatContractMs: 60_000,
      mutatesSettings: false,
      eligibleToRaiseTimeout: false,
    });
    expect(JSON.stringify(report)).not.toMatch(/token|authorization|secret/i);
  });
});
