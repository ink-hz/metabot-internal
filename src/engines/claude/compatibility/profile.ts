const OPUS_PROFILE_ID = 'nexcor-opus-4-8-claude-code-2.1.207';

export const OPUS_PROFILE = Object.freeze({
  id: OPUS_PROFILE_ID,
  claudeCodeVersion: '2.1.207' as const,
  allowedModels: Object.freeze(['claude-opus-4-8'] as const),
  contextWindow: 200_000 as const,
  promoteToolResultImages: true as const,
  nativeWebTools: Object.freeze(['WebSearch', 'WebFetch'] as const),
  nativeToolFailureMode: 'recoverable-turn' as const,
});

export type ClaudeCompatibilityProfile = typeof OPUS_PROFILE;

export function loadClaudeCompatibilityProfile(
  env: { METABOT_CLAUDE_COMPAT_PROFILE?: string } = process.env,
): ClaudeCompatibilityProfile | undefined {
  const profileId = env.METABOT_CLAUDE_COMPAT_PROFILE?.trim();
  if (!profileId) return undefined;
  if (profileId === OPUS_PROFILE_ID) return OPUS_PROFILE;
  throw new Error(`Unknown Claude compatibility profile: ${profileId}`);
}

export function assertAllowedClaudeModel(profile: ClaudeCompatibilityProfile, model?: string): void {
  if (!(profile.allowedModels as readonly string[]).includes(model ?? '')) {
    throw new Error(`Claude model ${model ?? '(unset)'} is not allowed by ${profile.id}`);
  }
}
