export interface ClaudeApiTimeoutPolicyEnv {
  METABOT_CLAUDE_API_TIMEOUT_MS?: string;
  METABOT_PROVIDER_STREAM_LIFETIME_VERIFIED?: string;
}

export function resolveClaudeApiTimeoutSettings(
  env: ClaudeApiTimeoutPolicyEnv,
): { API_TIMEOUT_MS: string } {
  const requested = env.METABOT_CLAUDE_API_TIMEOUT_MS?.trim() || '300000';
  if (requested !== '300000' && requested !== '600000') {
    throw new Error('METABOT_CLAUDE_API_TIMEOUT_MS must be 300000 or 600000');
  }
  if (requested === '600000'
    && env.METABOT_PROVIDER_STREAM_LIFETIME_VERIFIED?.trim().toLowerCase() !== 'true') {
    throw new Error(
      '600000ms Claude timeout requires provider stream lifetime verification',
    );
  }
  return { API_TIMEOUT_MS: requested };
}
