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

export function decideClaudeTurnRecovery(
  input: ClaudeTurnRecoveryInput,
): ClaudeTurnRecoveryDecision {
  if (input.completedOutputRecovered) return 'recover_completed';
  if (input.stopping || input.sideEffectSeen || input.replayCount >= 1) {
    return 'stop_without_replay';
  }
  return 'replay_fresh_once';
}
