import type { ReliabilityErrorClass } from '../reliability/public-error.js';
import type { ToolEffect } from './tool-effect.js';

export interface ProviderTurnRecoveryInput {
  errorClass: ReliabilityErrorClass | 'unknown';
  errorMessage?: string;
  toolEffect: ToolEffect;
  retryCount: number;
  stopping: boolean;
  hasUsableTerminalAnswer: boolean;
}

export type ProviderTurnRecoveryDecision = 'replay_fresh_once' | 'stop_without_replay';

const NON_TRANSIENT_PROVIDER_ERROR = /\b(?:400|401|403)\b|auth(?:entication|orization)?|permission|malformed|invalid request/i;
const TRANSIENT_PROVIDER_ERROR = /temporar(?:y|ily)|overload|capacity|try again|service unavailable/i;

function isTransientProviderFailure(input: ProviderTurnRecoveryInput): boolean {
  if (input.errorClass === 'timeout' || input.errorClass === 'gateway_transport') return true;
  if (input.errorClass !== 'provider_error') return false;
  const message = input.errorMessage ?? '';
  return !NON_TRANSIENT_PROVIDER_ERROR.test(message) && TRANSIENT_PROVIDER_ERROR.test(message);
}

export function decideProviderTurnRecovery(
  input: ProviderTurnRecoveryInput,
): ProviderTurnRecoveryDecision {
  if (input.stopping
    || input.retryCount >= 1
    || input.hasUsableTerminalAnswer
    || input.toolEffect !== 'read_only'
    || !isTransientProviderFailure(input)) {
    return 'stop_without_replay';
  }
  return 'replay_fresh_once';
}

export function providerTurnReplayDelayMs(random: () => number = Math.random): number {
  const jitter = Math.max(0, Math.min(0.999999, random()));
  return 2_000 + Math.floor(jitter * 3_001);
}
