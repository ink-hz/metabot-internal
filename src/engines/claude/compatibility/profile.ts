const OPUS_PROFILE_ID = 'nexcor-opus-4-8-claude-code-2.1.207';

export type CapabilityState = 'supported' | 'unsupported_expected' | 'required';

export interface CapabilityDeclaration {
  name: string;
  state: CapabilityState;
  reasonCode: string;
}

export const OPUS_PROFILE = Object.freeze({
  id: OPUS_PROFILE_ID,
  claudeCodeVersion: '2.1.207' as const,
  allowedModels: Object.freeze(['claude-opus-4-8'] as const),
  contextWindow: 200_000 as const,
  promoteToolResultImages: true as const,
  nativeWebTools: Object.freeze(['WebSearch', 'WebFetch'] as const),
  nativeToolFailureMode: 'recoverable-turn' as const,
  capabilities: Object.freeze([
    Object.freeze({ name: 'claude_code', state: 'required', reasonCode: 'P0_RUNTIME' }),
    Object.freeze({ name: 'local_tools', state: 'required', reasonCode: 'P0_LOCAL_TOOLS' }),
    Object.freeze({ name: 'document_output', state: 'required', reasonCode: 'P0_DOCUMENT_OUTPUT' }),
    Object.freeze({ name: 'native_web_search', state: 'unsupported_expected', reasonCode: 'GATEWAY_TOOL_TYPE_UNSUPPORTED' }),
    Object.freeze({ name: 'native_web_fetch', state: 'unsupported_expected', reasonCode: 'GATEWAY_TOOL_TYPE_UNSUPPORTED' }),
  ] as const satisfies readonly CapabilityDeclaration[]),
});

export type ClaudeCompatibilityProfile = typeof OPUS_PROFILE;

const DISABLED_CLAUDE_MODEL_RE = /^claude-fable-5(?:$|\[)/;

/** Product-level model gate. Fable stays disabled regardless of profile. */
export function assertEnabledClaudeModel(model?: string): void {
  if (model && DISABLED_CLAUDE_MODEL_RE.test(model)) {
    throw new Error(`Claude model ${model} is not allowed: temporarily disabled; use claude-opus-4-8`);
  }
}

export function loadClaudeCompatibilityProfile(
  env: { METABOT_CLAUDE_COMPAT_PROFILE?: string } = process.env,
): ClaudeCompatibilityProfile | undefined {
  const profileId = env.METABOT_CLAUDE_COMPAT_PROFILE?.trim();
  if (!profileId) return undefined;
  if (profileId === OPUS_PROFILE_ID) return OPUS_PROFILE;
  throw new Error(`Unknown Claude compatibility profile: ${profileId}`);
}

export function assertAllowedClaudeModel(profile: ClaudeCompatibilityProfile, model?: string): void {
  assertEnabledClaudeModel(model);
  if (!(profile.allowedModels as readonly string[]).includes(model ?? '')) {
    throw new Error(`Claude model ${model ?? '(unset)'} is not allowed by ${profile.id}`);
  }
}
