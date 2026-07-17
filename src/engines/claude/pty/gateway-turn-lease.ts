import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface LeaseOwner {
  pid: number;
  nonce: string;
  instanceName: string;
  acquiredAt: number;
}

export interface GatewayTurnLeaseHandle {
  release(): Promise<void>;
}

export interface GatewayTurnLease {
  acquire(options?: { cancelled?: () => boolean }): Promise<GatewayTurnLeaseHandle>;
}

export interface GatewayTurnLeaseOptions {
  lockDir: string;
  pid?: number;
  instanceName?: string;
  pollMs?: number;
  ownerInitializationGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

async function readOwner(lockDir: string): Promise<LeaseOwner | null> {
  try {
    const value = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as Partial<LeaseOwner>;
    if (!Number.isInteger(value.pid)
        || typeof value.nonce !== 'string'
        || typeof value.instanceName !== 'string'
        || typeof value.acquiredAt !== 'number') {
      return null;
    }
    return value as LeaseOwner;
  } catch {
    return null;
  }
}

async function reclaimStaleLock(options: Required<Pick<GatewayTurnLeaseOptions,
  'lockDir' | 'ownerInitializationGraceMs' | 'isProcessAlive' | 'now'>>): Promise<void> {
  const owner = await readOwner(options.lockDir);
  if (owner) {
    if (options.isProcessAlive(owner.pid)) return;
  } else {
    try {
      const info = await stat(options.lockDir);
      if (options.now() - info.mtimeMs < options.ownerInitializationGraceMs) return;
    } catch {
      return;
    }
  }

  const quarantine = `${options.lockDir}.stale-${randomUUID()}`;
  try {
    await rename(options.lockDir, quarantine);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
}

function createHandle(lockDir: string, nonce: string): GatewayTurnLeaseHandle {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const owner = await readOwner(lockDir);
      if (owner?.nonce !== nonce) return;
      const releasedDir = `${lockDir}.released-${nonce}`;
      try {
        await rename(lockDir, releasedDir);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return;
        throw error;
      }
      await rm(releasedDir, { recursive: true, force: true });
    },
  };
}

export function createGatewayTurnLease(options: GatewayTurnLeaseOptions): GatewayTurnLease {
  if (!path.isAbsolute(options.lockDir)) throw new Error('gateway turn lock directory must be absolute');
  const pid = options.pid ?? process.pid;
  const instanceName = options.instanceName?.trim() || `pid-${pid}`;
  const pollMs = options.pollMs ?? 200;
  const ownerInitializationGraceMs = options.ownerInitializationGraceMs ?? 5_000;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? Date.now;

  return {
    async acquire({ cancelled = () => false } = {}): Promise<GatewayTurnLeaseHandle> {
      while (!cancelled()) {
        const nonce = randomUUID();
        try {
          await mkdir(options.lockDir, { mode: 0o700 });
          try {
            const owner: LeaseOwner = { pid, nonce, instanceName, acquiredAt: now() };
            await writeFile(path.join(options.lockDir, 'owner.json'), `${JSON.stringify(owner)}\n`, {
              encoding: 'utf8',
              mode: 0o600,
              flag: 'wx',
            });
          } catch (error) {
            await rm(options.lockDir, { recursive: true, force: true });
            throw error;
          }
          return createHandle(options.lockDir, nonce);
        } catch (error) {
          if (!isNodeError(error, 'EEXIST')) throw error;
          await reclaimStaleLock({
            lockDir: options.lockDir,
            ownerInitializationGraceMs,
            isProcessAlive,
            now,
          });
          if (!cancelled()) await sleep(pollMs);
        }
      }
      throw new Error('gateway turn lease acquisition cancelled');
    },
  };
}
