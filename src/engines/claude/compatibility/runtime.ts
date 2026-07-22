import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../../utils/logger.js';
import {
  startClaudeGatewayAdapter,
  type ClaudeGatewayAdapter,
  type ClaudeGatewayAdapterOptions,
} from './adapter.js';
import type { ClaudeCompatibilityProfile } from './profile.js';
import {
  assertCompatibleClaudeVersion,
  type ClaudeVersionRunner,
} from './version.js';
import { resolveClaudeApiTimeoutSettings } from './timeout-policy.js';

export interface ClaudeCompatibilityRuntime {
  profile: ClaudeCompatibilityProfile;
  childEnv: NodeJS.ProcessEnv;
  settingsEnv: Record<string, string>;
  close(): Promise<void>;
}

export interface StartClaudeCompatibilityRuntimeOptions {
  profile: ClaudeCompatibilityProfile;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  sourceSettingsPath?: string;
  claudeExecutable?: string;
  versionRunner?: ClaudeVersionRunner;
  adapterStarter?: (options: ClaudeGatewayAdapterOptions) => Promise<ClaudeGatewayAdapter>;
}

let activeRuntime: ClaudeCompatibilityRuntime | undefined;

function readSettingsEnv(sourceSettingsPath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(sourceSettingsPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const env = (parsed as { env?: unknown }).env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function resolveClaudeExecutable(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDE_EXECUTABLE_PATH?.trim()) return env.CLAUDE_EXECUTABLE_PATH.trim();
  try {
    const command = process.platform === 'win32' ? 'where claude' : 'which claude';
    return execSync(command, { encoding: 'utf8', env }).trim().split(/\r?\n/)[0];
  } catch {
    return process.platform === 'win32' ? 'claude' : '/usr/local/bin/claude';
  }
}

export async function startClaudeCompatibilityRuntime(
  options: StartClaudeCompatibilityRuntimeOptions,
): Promise<ClaudeCompatibilityRuntime> {
  const env = options.env ?? process.env;
  const sourceSettingsPath = options.sourceSettingsPath
    ?? join(homedir(), '.claude', 'settings.json');
  // Claude Code settings env wins over child process env, so capture the
  // effective upstream and credential with the same precedence before either
  // layer is replaced with the loopback URL.
  const effectiveEnv = { ...env, ...readSettingsEnv(sourceSettingsPath) };
  const upstreamBaseUrl = effectiveEnv.ANTHROPIC_BASE_URL?.trim();
  if (!upstreamBaseUrl) {
    throw new Error('Claude compatibility profile requires ANTHROPIC_BASE_URL');
  }

  const authName = effectiveEnv.ANTHROPIC_AUTH_TOKEN?.trim()
    ? 'ANTHROPIC_AUTH_TOKEN'
    : effectiveEnv.ANTHROPIC_API_KEY?.trim()
      ? 'ANTHROPIC_API_KEY'
      : undefined;
  if (!authName) {
    throw new Error('Claude compatibility profile requires an Anthropic credential');
  }
  const authToken = effectiveEnv[authName]!.trim();
  const claudeExecutable = options.claudeExecutable ?? resolveClaudeExecutable(env);
  assertCompatibleClaudeVersion(options.profile, claudeExecutable, options.versionRunner);

  const adapterStarter = options.adapterStarter ?? startClaudeGatewayAdapter;
  const adapter = await adapterStarter({
    upstreamBaseUrl,
    authToken,
    unsupportedRequestBetas: options.profile.unsupportedRequestBetas,
    logger: options.logger,
  });
  const overrides = {
    ...resolveClaudeApiTimeoutSettings(effectiveEnv),
    ANTHROPIC_BASE_URL: adapter.baseUrl,
    [authName]: authToken,
  };
  let closed = false;
  return {
    profile: options.profile,
    childEnv: { ...overrides },
    settingsEnv: { ...overrides },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await adapter.close();
    },
  };
}

export function applyClaudeCompatibilityRuntime(
  queryOptions: Record<string, unknown>,
  runtime: ClaudeCompatibilityRuntime,
): void {
  const existingEnv = queryOptions.env;
  queryOptions.env = {
    ...(existingEnv && typeof existingEnv === 'object' && !Array.isArray(existingEnv)
      ? existingEnv as Record<string, unknown>
      : {}),
    ...runtime.childEnv,
  };

  const existingSettings = queryOptions.settings;
  const settings = existingSettings && typeof existingSettings === 'object' && !Array.isArray(existingSettings)
    ? existingSettings as Record<string, unknown>
    : {};
  const existingSettingsEnv = settings.env;
  queryOptions.settings = {
    ...settings,
    env: {
      ...(existingSettingsEnv && typeof existingSettingsEnv === 'object' && !Array.isArray(existingSettingsEnv)
        ? existingSettingsEnv as Record<string, unknown>
        : {}),
      ...runtime.settingsEnv,
    },
  };
}

export function setActiveClaudeCompatibilityRuntime(runtime: ClaudeCompatibilityRuntime): void {
  if (activeRuntime && activeRuntime !== runtime) {
    throw new Error('A Claude compatibility runtime is already active');
  }
  activeRuntime = runtime;
}

export function getActiveClaudeCompatibilityRuntime(): ClaudeCompatibilityRuntime | undefined {
  return activeRuntime;
}

export function clearActiveClaudeCompatibilityRuntime(): void {
  activeRuntime = undefined;
}

export function getRuntimeForProfile(
  profile: ClaudeCompatibilityProfile | undefined,
): ClaudeCompatibilityRuntime | undefined {
  if (!profile) return undefined;
  if (!activeRuntime) {
    throw new Error(`Claude compatibility runtime ${profile.id} has not started`);
  }
  if (activeRuntime.profile.id !== profile.id) {
    throw new Error(
      `Claude compatibility runtime ${activeRuntime.profile.id} does not match ${profile.id}`,
    );
  }
  return activeRuntime;
}
