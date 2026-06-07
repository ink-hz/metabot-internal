import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getBridgeRuntimeInfo } from '../src/runtime-info.js';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('getBridgeRuntimeInfo', () => {
  it('reports Node as the production default even when a Bun opt-in path exists', () => {
    const info = getBridgeRuntimeInfo();

    expect(info.productionDefaultRuntime).toBe('node');
    expect(info.pm2Launch).toBe('node --import tsx src/index.ts');
    expect(info.bunOptInLaunch).toBe('bun run src/index.ts');
    expect(info.nativeDependencies).toEqual(['better-sqlite3', 'node-pty']);
  });

  it('marks Bun verified only when the active process is Bun', () => {
    const info = getBridgeRuntimeInfo();
    const expectedRuntime = (process.versions as Record<string, string | undefined>).bun ? 'bun' : 'node';

    expect(info.activeRuntime).toBe(expectedRuntime);
    expect(info.bunVerified).toBe(expectedRuntime === 'bun');
    expect(info.activeVersion).toBeTruthy();
  });

  it('exposes runtime metadata on the API health response and keeps Bun opt-in', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'api', 'http-server.ts'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

    expect(source).toContain("import { getBridgeRuntimeInfo } from '../runtime-info.js'");
    expect(source).toContain('runtime: getBridgeRuntimeInfo()');
    expect(pkg.scripts.dev).toBe('tsx src/index.ts');
    expect(pkg.scripts['dev:bun']).toBe('node scripts/run-bun-if-available.mjs run src/index.ts');
  });
});
