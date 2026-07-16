import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPUS_PROFILE } from '../src/engines/claude/compatibility/profile.js';
import {
  applyClaudeCompatibilityRuntime,
  clearActiveClaudeCompatibilityRuntime,
  getActiveClaudeCompatibilityRuntime,
  setActiveClaudeCompatibilityRuntime,
  startClaudeCompatibilityRuntime,
  type ClaudeCompatibilityRuntime,
} from '../src/engines/claude/compatibility/runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  const active = getActiveClaudeCompatibilityRuntime();
  clearActiveClaudeCompatibilityRuntime();
  if (active) await active.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settingsFile(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-runtime-test-'));
  tempDirs.push(dir);
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ env }), { mode: 0o600 });
  return file;
}

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} } as any;
}

describe('Claude compatibility runtime', () => {
  it('uses settings URL precedence, asserts the CLI version, and overrides both env layers', async () => {
    const starts: Array<{
      upstreamBaseUrl: string;
      authToken: string;
      unsupportedRequestBetas?: readonly string[];
    }> = [];
    let closed = false;
    const runtime = await startClaudeCompatibilityRuntime({
      profile: OPUS_PROFILE,
      logger: fakeLogger(),
      env: {
        ANTHROPIC_BASE_URL: 'https://process.example',
        ANTHROPIC_AUTH_TOKEN: 'process-token',
      },
      sourceSettingsPath: settingsFile({
        ANTHROPIC_BASE_URL: 'https://settings.example',
        ANTHROPIC_AUTH_TOKEN: 'settings-token',
      }),
      claudeExecutable: '/fake/claude',
      versionRunner: () => '2.1.207 (Claude Code)',
      adapterStarter: async (options) => {
        starts.push({
          upstreamBaseUrl: options.upstreamBaseUrl,
          authToken: options.authToken,
          unsupportedRequestBetas: options.unsupportedRequestBetas,
        });
        return { baseUrl: 'http://127.0.0.1:43123', close: async () => { closed = true; } };
      },
    });

    expect(starts).toEqual([{
      upstreamBaseUrl: 'https://settings.example',
      authToken: 'settings-token',
      unsupportedRequestBetas: OPUS_PROFILE.unsupportedRequestBetas,
    }]);
    expect(runtime.childEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
      ANTHROPIC_AUTH_TOKEN: 'settings-token',
    });
    expect(runtime.settingsEnv).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
      ANTHROPIC_AUTH_TOKEN: 'settings-token',
    });
    expect(runtime).not.toHaveProperty('deniedTools');
    expect(runtime).not.toHaveProperty('mcpConfigPath');

    await runtime.close();
    expect(closed).toBe(true);
  });

  it('refuses startup when the gateway URL, credential, or CLI version is incompatible', async () => {
    const common = {
      profile: OPUS_PROFILE,
      logger: fakeLogger(),
      sourceSettingsPath: settingsFile({}),
      claudeExecutable: '/fake/claude',
      adapterStarter: async () => ({ baseUrl: 'http://127.0.0.1:1', close: async () => {} }),
    };
    await expect(startClaudeCompatibilityRuntime({
      ...common, env: {}, versionRunner: () => '2.1.207 (Claude Code)',
    })).rejects.toThrow(/ANTHROPIC_BASE_URL/);
    await expect(startClaudeCompatibilityRuntime({
      ...common, env: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
      versionRunner: () => '2.1.207 (Claude Code)',
    })).rejects.toThrow(/credential/);
    await expect(startClaudeCompatibilityRuntime({
      ...common,
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 'token' },
      versionRunner: () => '2.1.208 (Claude Code)',
    })).rejects.toThrow(/expected 2\.1\.207/);
  });

  it('merges runtime values after ordinary query options without denying native web tools', () => {
    const runtime = {
      profile: OPUS_PROFILE,
      childEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123', ANTHROPIC_AUTH_TOKEN: 'token' },
      settingsEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123', ANTHROPIC_AUTH_TOKEN: 'token' },
      close: async () => {},
    } satisfies ClaudeCompatibilityRuntime;
    const options: Record<string, any> = {
      env: { KEEP: 'yes', ANTHROPIC_BASE_URL: 'https://wrong.example' },
      settings: { teammateMode: 'in-process', env: { KEEP_SETTING: 'yes' } },
    };

    applyClaudeCompatibilityRuntime(options, runtime);

    expect(options.env).toMatchObject({ KEEP: 'yes', ANTHROPIC_BASE_URL: runtime.childEnv.ANTHROPIC_BASE_URL });
    expect(options.settings.env).toEqual({
      KEEP_SETTING: 'yes',
      ANTHROPIC_BASE_URL: runtime.settingsEnv.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'token',
    });
    expect(options.disallowedTools ?? []).not.toContain('WebSearch');
    expect(options.disallowedTools ?? []).not.toContain('WebFetch');
    expect(options.mcpServers ?? {}).not.toHaveProperty('tavily');
  });

  it('owns one active runtime and rejects accidental replacement', () => {
    const runtime = {
      profile: OPUS_PROFILE, childEnv: {}, settingsEnv: {}, close: async () => {},
    } satisfies ClaudeCompatibilityRuntime;
    setActiveClaudeCompatibilityRuntime(runtime);
    expect(getActiveClaudeCompatibilityRuntime()).toBe(runtime);
    expect(() => setActiveClaudeCompatibilityRuntime({ ...runtime })).toThrow(/already active/);
  });
});
