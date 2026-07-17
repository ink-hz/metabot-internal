import { describe, expect, it } from 'vitest';
import {
  claudeTurnReplayDelayMs,
  decideClaudeTurnRecovery,
  MAX_CLAUDE_TURN_ATTEMPTS,
} from '../src/bridge/claude-turn-recovery.js';

describe('Claude turn recovery policy', () => {
  it('allows two safe replays before any side effect', () => {
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: false,
      sideEffectSeen: false,
      replayCount: 0,
      stopping: false,
    })).toBe('replay_fresh_once');
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: false,
      sideEffectSeen: false,
      replayCount: 1,
      stopping: false,
    })).toBe('replay_fresh_once');
    expect(MAX_CLAUDE_TURN_ATTEMPTS).toBe(3);
    expect(claudeTurnReplayDelayMs(0)).toBe(500);
    expect(claudeTurnReplayDelayMs(1)).toBe(1000);
  });

  it('never replays after a possible side effect', () => {
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: false,
      sideEffectSeen: true,
      replayCount: 0,
      stopping: false,
    })).toBe('stop_without_replay');
  });

  it('never loops or overrides an explicit stop', () => {
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: false,
      sideEffectSeen: false,
      replayCount: 2,
      stopping: false,
    })).toBe('stop_without_replay');
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: false,
      sideEffectSeen: false,
      replayCount: 0,
      stopping: true,
    })).toBe('stop_without_replay');
  });

  it('uses recovered completed output without replay', () => {
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: true,
      sideEffectSeen: false,
      replayCount: 0,
      stopping: false,
    })).toBe('recover_completed');
  });
});
