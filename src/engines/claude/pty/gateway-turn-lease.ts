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
  globalCapacity?: number;
  instanceCapacity?: number;
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

interface SlotOptions {
  slotDir: string;
  pid: number;
  instanceName: string;
  ownerInitializationGraceMs: number;
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
}

async function reclaimStaleLock(options: SlotOptions): Promise<void> {
  const owner = await readOwner(options.slotDir);
  if (owner) {
    if (options.isProcessAlive(owner.pid)) return;
  } else {
    try {
      const info = await stat(options.slotDir);
      if (options.now() - info.mtimeMs < options.ownerInitializationGraceMs) return;
    } catch {
      return;
    }
  }

  const quarantine = `${options.slotDir}.stale-${randomUUID()}`;
  try {
    await rename(options.slotDir, quarantine);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
}

function createHandle(slotDir: string, nonce: string): GatewayTurnLeaseHandle {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const owner = await readOwner(slotDir);
      if (owner?.nonce !== nonce) return;
      const releasedDir = `${slotDir}.released-${nonce}`;
      try {
        await rename(slotDir, releasedDir);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return;
        throw error;
      }
      await rm(releasedDir, { recursive: true, force: true });
    },
  };
}

function positiveCapacity(value: number | undefined, label: string): number {
  const capacity = value ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000) {
    throw new Error(`${label} must be an integer between 1 and 1000`);
  }
  return capacity;
}

async function acquireSlot(
  scopeDir: string,
  capacity: number,
  options: Omit<SlotOptions, 'slotDir'> & { pollMs: number; cancelled: () => boolean },
): Promise<GatewayTurnLeaseHandle> {
  await mkdir(scopeDir, { recursive: true, mode: 0o700 });
  while (!options.cancelled()) {
    for (let slot = 0; slot < capacity && !options.cancelled(); slot += 1) {
      const slotDir = path.join(scopeDir, `slot-${slot}`);
      const nonce = randomUUID();
      try {
        await mkdir(slotDir, { mode: 0o700 });
        try {
          const owner: LeaseOwner = {
            pid: options.pid,
            nonce,
            instanceName: options.instanceName,
            acquiredAt: options.now(),
          };
          await writeFile(path.join(slotDir, 'owner.json'), `${JSON.stringify(owner)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
          });
        } catch (error) {
          await rm(slotDir, { recursive: true, force: true });
          throw error;
        }
        return createHandle(slotDir, nonce);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        await reclaimStaleLock({
          slotDir,
          pid: options.pid,
          instanceName: options.instanceName,
          ownerInitializationGraceMs: options.ownerInitializationGraceMs,
          isProcessAlive: options.isProcessAlive,
          now: options.now,
        });
      }
    }
    if (!options.cancelled()) await sleep(options.pollMs);
  }
  throw new Error('gateway turn lease acquisition cancelled');
}

function instanceScope(lockDir: string, instanceName: string): string {
  const key = Buffer.from(instanceName, 'utf8').toString('base64url');
  return path.join(lockDir, 'instances', key);
}

export function createGatewayTurnLease(options: GatewayTurnLeaseOptions): GatewayTurnLease {
  if (!path.isAbsolute(options.lockDir)) throw new Error('gateway turn lock directory must be absolute');
  const pid = options.pid ?? process.pid;
  const instanceName = options.instanceName?.trim() || `pid-${pid}`;
  const pollMs = options.pollMs ?? 200;
  const ownerInitializationGraceMs = options.ownerInitializationGraceMs ?? 5_000;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? Date.now;
  const globalCapacity = positiveCapacity(options.globalCapacity, 'global capacity');
  const instanceCapacity = positiveCapacity(options.instanceCapacity, 'instance capacity');

  return {
    async acquire({ cancelled = () => false } = {}): Promise<GatewayTurnLeaseHandle> {
      const common = {
        pid,
        instanceName,
        pollMs,
        ownerInitializationGraceMs,
        isProcessAlive,
        now,
        cancelled,
      };
      const instanceHandle = await acquireSlot(
        instanceScope(options.lockDir, instanceName),
        instanceCapacity,
        common,
      );
      let globalHandle: GatewayTurnLeaseHandle;
      try {
        globalHandle = await acquireSlot(
          path.join(options.lockDir, 'global'),
          globalCapacity,
          common,
        );
      } catch (error) {
        await instanceHandle.release();
        throw error;
      }

      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            await globalHandle.release();
          } finally {
            await instanceHandle.release();
          }
        },
      };
    },
  };
}
