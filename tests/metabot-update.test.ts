import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METABOT_BIN = path.join(REPO_ROOT, 'bin', 'metabot');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-update-test-'));
}

describe('metabot update source selection', () => {
  it('defaults to the internal package refresh even when .git exists', () => {
    const tmp = makeTempDir();
    const fakeBin = path.join(tmp, 'bin');
    const metabotHome = path.join(tmp, 'metabot');
    const marker = path.join(tmp, 'marker.txt');
    const curlArgs = path.join(tmp, 'curl-args.txt');

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(path.join(metabotHome, '.git'), { recursive: true });
    fs.writeFileSync(path.join(metabotHome, 'install.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" > "$CURL_ARGS_FILE"',
        'cat <<\'SH\'',
        '#!/usr/bin/env bash',
        'printf "package:%s\\n" "$METABOT_HOME" > "$MARKER"',
        'SH',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    execFileSync('bash', [METABOT_BIN, 'update'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        METABOT_HOME: metabotHome,
        METABOT_CORE_URL: 'https://core.example.test',
        MARKER: marker,
        CURL_ARGS_FILE: curlArgs,
      },
      stdio: 'pipe',
    });

    expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(`package:${metabotHome}`);
    expect(fs.readFileSync(curlArgs, 'utf-8')).toContain('https://core.example.test/install/install.sh');
  });

  it('documents the explicit developer git opt-in path', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('METABOT_UPDATE_SOURCE:-package');
    expect(source).toContain('metabot update --git');
    expect(source).toContain('exec "$METABOT_HOME/bin/metabot" update --git');
  });
});
