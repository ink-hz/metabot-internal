import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FILE_NAME = 'instance-id';
let cached: { dir: string; id: string } | undefined;

function defaultStateDir(): string {
  return process.env.METABOT_RUNTIME_STATE_DIR
    || process.env.SESSION_STORE_DIR
    || path.join(os.homedir(), '.metabot');
}

function newInstanceId(): string {
  return `metabot-${crypto.randomBytes(6).toString('hex')}`;
}

/** Stable, non-secret identity for this runtime installation. */
export function loadOrCreateInstanceId(stateDir = defaultStateDir()): string {
  if (cached?.dir === stateDir) return cached.id;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, FILE_NAME);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^metabot-[0-9a-f]{12}$/.test(existing)) {
      fs.chmodSync(file, 0o600);
      cached = { dir: stateDir, id: existing };
      return existing;
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const id = newInstanceId();
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${id}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error: any) {
    fs.rmSync(temp, { force: true });
    if (error?.code !== 'EEXIST') throw error;
    return loadOrCreateInstanceId(stateDir);
  }
  fs.chmodSync(file, 0o600);
  cached = { dir: stateDir, id };
  return id;
}

export function getRuntimeInstanceId(): string {
  return loadOrCreateInstanceId();
}
