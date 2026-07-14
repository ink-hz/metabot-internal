import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config.js';
import {
  OPUS_PROFILE,
  assertAllowedClaudeModel,
  loadClaudeCompatibilityProfile,
} from '../src/engines/claude/compatibility/profile.js';
import { assertCompatibleClaudeVersion } from '../src/engines/claude/compatibility/version.js';

const originalBotsConfig = process.env.BOTS_CONFIG;
const originalProfile = process.env.METABOT_CLAUDE_COMPAT_PROFILE;
const originalEngine = process.env.METABOT_ENGINE;
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = originalBotsConfig;
  if (originalProfile === undefined) delete process.env.METABOT_CLAUDE_COMPAT_PROFILE;
  else process.env.METABOT_CLAUDE_COMPAT_PROFILE = originalProfile;
  if (originalEngine === undefined) delete process.env.METABOT_ENGINE;
  else process.env.METABOT_ENGINE = originalEngine;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function useWebBotConfig(model: string, engine: 'claude' | 'codex' | null = 'claude'): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-profile-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'bots.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      webBots: [
        {
          name: 'claude-test',
          ...(engine ? { engine } : {}),
          defaultWorkingDirectory: dir,
          model,
        },
      ],
    }),
  );
  process.env.BOTS_CONFIG = configPath;
}

function useSingleBotEnv(platform: 'feishu' | 'telegram' | 'wechat'): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-env-profile-'));
  tempDirs.push(dir);
  vi.stubEnv('BOTS_CONFIG', '');
  vi.stubEnv('METABOT_CLAUDE_COMPAT_PROFILE', OPUS_PROFILE.id);
  vi.stubEnv('METABOT_ENGINE', 'claude');
  vi.stubEnv('CLAUDE_DEFAULT_WORKING_DIRECTORY', dir);
  vi.stubEnv('CLAUDE_MODEL', '');
  vi.stubEnv('FEISHU_APP_ID', '');
  vi.stubEnv('FEISHU_APP_SECRET', '');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('WECHAT_BOT_TOKEN', '');
  vi.stubEnv('WECHAT_ILINK_ENABLED', 'false');

  if (platform === 'feishu') {
    vi.stubEnv('FEISHU_APP_ID', 'app-id');
    vi.stubEnv('FEISHU_APP_SECRET', 'app-secret');
  } else if (platform === 'telegram') {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
  } else {
    vi.stubEnv('WECHAT_ILINK_ENABLED', 'true');
  }
}

describe('Claude compatibility profile', () => {
  it('loads the immutable Opus 4.8 / Claude Code 2.1.207 profile', () => {
    const profile = loadClaudeCompatibilityProfile({
      METABOT_CLAUDE_COMPAT_PROFILE: 'nexcor-opus-4-8-claude-code-2.1.207',
    });

    expect(profile).toMatchObject({
      claudeCodeVersion: '2.1.207',
      allowedModels: ['claude-opus-4-8'],
      contextWindow: 200_000,
      promoteToolResultImages: true,
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile?.allowedModels)).toBe(true);
  });

  it('leaves generic behavior unprofiled when the selector is unset', () => {
    expect(loadClaudeCompatibilityProfile({ METABOT_CLAUDE_COMPAT_PROFILE: undefined })).toBeUndefined();
  });

  it('rejects unknown profile selectors', () => {
    expect(() =>
      loadClaudeCompatibilityProfile({
        METABOT_CLAUDE_COMPAT_PROFILE: 'unknown-profile',
      }),
    ).toThrow(/unknown-profile/);
  });

  it('allows only the exact Opus model identifier', () => {
    expect(() => assertAllowedClaudeModel(OPUS_PROFILE, 'claude-opus-4-8')).not.toThrow();
    expect(() => assertAllowedClaudeModel(OPUS_PROFILE, 'claude-fable-5')).toThrow(/not allowed/);
    expect(() => assertAllowedClaudeModel(OPUS_PROFILE, 'claude-opus-4-8[1m]')).toThrow(/not allowed/);
    expect(() => assertAllowedClaudeModel(OPUS_PROFILE, undefined)).toThrow(/not allowed/);
  });

  it('requires the exact Claude Code version from the resolved executable', () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    assertCompatibleClaudeVersion(OPUS_PROFILE, '/opt/claude', (executable, args) => {
      calls.push({ executable, args });
      return '2.1.207 (Claude Code)';
    });

    expect(calls).toEqual([{ executable: '/opt/claude', args: ['--version'] }]);
    expect(() => assertCompatibleClaudeVersion(OPUS_PROFILE, '/opt/claude', () => '2.1.208 (Claude Code)')).toThrow(
      /expected 2\.1\.207/,
    );
  });

  it('rejects a prerelease of the pinned Claude Code version', () => {
    expect(() =>
      assertCompatibleClaudeVersion(OPUS_PROFILE, '/opt/claude', () => '2.1.207-beta.1 (Claude Code)'),
    ).toThrow(/expected 2\.1\.207/);
  });

  it('rejects a four-part extension of the pinned Claude Code version', () => {
    expect(() => assertCompatibleClaudeVersion(OPUS_PROFILE, '/opt/claude', () => '2.1.207.1 (Claude Code)')).toThrow(
      /expected 2\.1\.207/,
    );
  });

  it('binds an allowed Claude bot during config load', () => {
    useWebBotConfig('claude-opus-4-8');
    process.env.METABOT_CLAUDE_COMPAT_PROFILE = OPUS_PROFILE.id;

    const config = loadAppConfig();

    expect(config.webBots[0].claude.model).toBe('claude-opus-4-8');
    expect(config.webBots[0].claude.compatibilityProfile).toBe(OPUS_PROFILE);
  });

  it('rejects a disallowed Claude bot during config load', () => {
    useWebBotConfig('claude-fable-5');
    process.env.METABOT_CLAUDE_COMPAT_PROFILE = OPUS_PROFILE.id;

    expect(() => loadAppConfig()).toThrow(/claude-fable-5.*not allowed/);
  });

  it('rejects a disallowed Claude fallback for a bot currently using another engine', () => {
    useWebBotConfig('claude-fable-5', 'codex');
    process.env.METABOT_CLAUDE_COMPAT_PROFILE = OPUS_PROFILE.id;

    expect(() => loadAppConfig()).toThrow(/claude-fable-5.*not allowed/);
  });

  it('rejects a disallowed model selected through the global Claude engine default', () => {
    useWebBotConfig('claude-fable-5', null);
    process.env.METABOT_ENGINE = 'claude';
    process.env.METABOT_CLAUDE_COMPAT_PROFILE = OPUS_PROFILE.id;

    expect(() => loadAppConfig()).toThrow(/claude-fable-5.*not allowed/);
  });

  it('preserves generic config loading when no profile is selected', () => {
    useWebBotConfig('claude-sonnet-4-6');
    delete process.env.METABOT_CLAUDE_COMPAT_PROFILE;

    const config = loadAppConfig();

    expect(config.webBots[0].claude.model).toBe('claude-sonnet-4-6');
    expect(config.webBots[0].claude.compatibilityProfile).toBeUndefined();
  });

  it.each(['feishu', 'telegram', 'wechat'] as const)(
    'does not apply the old generic fallback in %s single-bot env mode',
    (platform) => {
      useSingleBotEnv(platform);

      expect(() => loadAppConfig()).toThrow(/Claude model \(unset\) is not allowed/);
    },
  );
});
