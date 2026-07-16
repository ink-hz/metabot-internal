import { describe, expect, it } from 'vitest';
import { decideClaudeTurnRecovery } from '../src/bridge/claude-turn-recovery.js';

describe('Claude turn recovery policy', () => {
  it('replays once only before any side effect', () => {
    expect(decideClaudeTurnRecovery({
      completedOutputRecovered: false,
      sideEffectSeen: false,
      replayCount: 0,
      stopping: false,
    })).toBe('replay_fresh_once');
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
      replayCount: 1,
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
