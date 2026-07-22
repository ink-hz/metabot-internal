import { describe, expect, it } from 'vitest';
import {
  decideProviderTurnRecovery,
  providerTurnReplayDelayMs,
} from '../src/bridge/provider-turn-recovery.js';

const base = {
  errorClass: 'timeout' as const,
  errorMessage: 'API Error: The operation timed out.',
  toolEffect: 'read_only' as const,
  retryCount: 0,
  stopping: false,
  hasUsableTerminalAnswer: false,
};

describe('provider turn recovery policy', () => {
  it('replays one transient pre-side-effect failure in a fresh session', () => {
    expect(decideProviderTurnRecovery(base)).toBe('replay_fresh_once');
    expect(decideProviderTurnRecovery({ ...base, errorClass: 'gateway_transport' }))
      .toBe('replay_fresh_once');
    expect(decideProviderTurnRecovery({
      ...base,
      errorClass: 'provider_error',
      errorMessage: 'API Error: service temporarily overloaded',
    })).toBe('replay_fresh_once');
  });

  it('stops after one retry or any unsafe condition', () => {
    expect(decideProviderTurnRecovery({ ...base, retryCount: 1 })).toBe('stop_without_replay');
    expect(decideProviderTurnRecovery({ ...base, stopping: true })).toBe('stop_without_replay');
    expect(decideProviderTurnRecovery({ ...base, hasUsableTerminalAnswer: true }))
      .toBe('stop_without_replay');
    expect(decideProviderTurnRecovery({ ...base, toolEffect: 'local_idempotent' }))
      .toBe('stop_without_replay');
    expect(decideProviderTurnRecovery({ ...base, toolEffect: 'external_side_effect' }))
      .toBe('stop_without_replay');
  });

  it('does not retry non-transient provider, auth, malformed, model, or session errors', () => {
    for (const input of [
      { errorClass: 'provider_error' as const, errorMessage: 'API Error: 400 malformed request' },
      { errorClass: 'provider_error' as const, errorMessage: 'API Error: 401 authentication failed' },
      { errorClass: 'model_mismatch' as const, errorMessage: 'configured model mismatch' },
      { errorClass: 'claude_session' as const, errorMessage: 'invalid session id' },
    ]) {
      expect(decideProviderTurnRecovery({ ...base, ...input })).toBe('stop_without_replay');
    }
  });

  it('uses a bounded 2-5 second jitter window', () => {
    expect(providerTurnReplayDelayMs(() => 0)).toBe(2_000);
    expect(providerTurnReplayDelayMs(() => 0.9999)).toBeLessThanOrEqual(5_000);
    expect(providerTurnReplayDelayMs(() => 0.9999)).toBeGreaterThanOrEqual(2_000);
  });
});
