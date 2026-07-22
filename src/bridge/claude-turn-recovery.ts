export interface ClaudeTurnRecoveryInput {
  completedOutputRecovered: boolean;
  sideEffectSeen: boolean;
  replayCount: number;
  stopping: boolean;
}

export type ClaudeTurnRecoveryDecision =
  | 'recover_completed'
  | 'replay_fresh_once'
  | 'stop_without_replay';

export const MAX_CLAUDE_TURN_ATTEMPTS = 2;
const CLAUDE_TURN_REPLAY_BASE_DELAY_MS = 2_000;

export function claudeTurnReplayDelayMs(replayCount: number): number {
  return CLAUDE_TURN_REPLAY_BASE_DELAY_MS * 2 ** replayCount;
}

export function decideClaudeTurnRecovery(
  input: ClaudeTurnRecoveryInput,
): ClaudeTurnRecoveryDecision {
  if (input.completedOutputRecovered) return 'recover_completed';
  if (input.stopping || input.sideEffectSeen
      || input.replayCount >= MAX_CLAUDE_TURN_ATTEMPTS - 1) {
    return 'stop_without_replay';
  }
  return 'replay_fresh_once';
}
