export type ClaudeTurnPhase =
  | 'accepted'
  | 'process_starting'
  | 'prompt_dispatched'
  | 'output_started'
  | 'side_effect_started'
  | 'completed';

const PHASE_ORDER: Readonly<Record<ClaudeTurnPhase, number>> = Object.freeze({
  accepted: 0,
  process_starting: 1,
  prompt_dispatched: 2,
  output_started: 3,
  side_effect_started: 4,
  completed: 5,
});

export interface ClaudeProcessExitDetails {
  exitCode: number | null;
  signal?: number;
  phase: ClaudeTurnPhase;
  sessionRef?: string;
  completedOutputRecovered: boolean;
  toolSideEffectSeen: boolean;
}

export function advanceClaudeTurnPhase(
  current: ClaudeTurnPhase,
  next: ClaudeTurnPhase,
): ClaudeTurnPhase {
  if (PHASE_ORDER[next] < PHASE_ORDER[current]) {
    throw new Error(`Claude turn phase regression: ${current} -> ${next}`);
  }
  return next;
}

export class ClaudeProcessExitError extends Error {
  readonly code = 'CLAUDE_PROCESS_EXIT' as const;

  constructor(readonly details: ClaudeProcessExitDetails) {
    super('Claude process exited unexpectedly');
    this.name = 'ClaudeProcessExitError';
  }
}

export function isClaudeProcessExitError(value: unknown): value is ClaudeProcessExitError {
  return value instanceof ClaudeProcessExitError
    || Boolean(value && typeof value === 'object'
      && (value as { code?: unknown }).code === 'CLAUDE_PROCESS_EXIT');
}
