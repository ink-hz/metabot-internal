import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metabot-hook-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('createHookBridge settings generation', () => {
  it('preserves user settings and appends the MetaBot Stop hook privately', async () => {
    const root = temporaryRoot();
    const sourceSettingsPath = join(root, '.claude', 'settings.json');
    mkdirSync(dirname(sourceSettingsPath), { recursive: true });
    writeFileSync(
      sourceSettingsPath,
      JSON.stringify({
        theme: 'dark',
        skipDangerousModePermissionPrompt: true,
        env: { ANTHROPIC_AUTH_TOKEN: 'test-secret' },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'user-start-hook' }] }],
        },
      }),
    );

    const bridge = createHookBridge({ sourceSettingsPath });
    const generatedPath = await bridge.writeSettings();
    const generated = JSON.parse(readFileSync(generatedPath, 'utf8'));

    expect(generated.theme).toBe('dark');
    expect(generated.skipDangerousModePermissionPrompt).toBe(true);
    expect(generated.env.ANTHROPIC_AUTH_TOKEN).toBe('test-secret');
    expect(generated.hooks.SessionStart).toHaveLength(1);
    expect(generated.hooks.Stop).toHaveLength(2);
    expect(generated.hooks.Stop[0].hooks[0].command).toBe('user-stop-hook');
    expect(generated.hooks.Stop[1].hooks[0].command).toContain('stop.flag');
    expect(statSync(dirname(generatedPath)).mode & 0o777).toBe(0o700);
    expect(statSync(generatedPath).mode & 0o777).toBe(0o600);

    await bridge.dispose();
  });

  it.each([
    ['missing', undefined],
    ['malformed', '{not-json'],
    ['array', '[]'],
    ['primitive', '42'],
  ])('falls back to hooks-only settings for %s user settings', async (_name, content) => {
    const root = temporaryRoot();
    const sourceSettingsPath = join(root, 'settings.json');
    if (content !== undefined) writeFileSync(sourceSettingsPath, content);

    const bridge = createHookBridge({ sourceSettingsPath });
    const generatedPath = await bridge.writeSettings();
    const generated = JSON.parse(readFileSync(generatedPath, 'utf8'));

    expect(Object.keys(generated)).toEqual(['hooks']);
    expect(generated.hooks.Stop).toHaveLength(1);

    await bridge.dispose();
  });
});
