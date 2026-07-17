import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayTurnLease } from '../src/engines/claude/pty/gateway-turn-lease.js';

const roots: string[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function lockPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'metabot-gateway-lease-'));
  roots.push(root);
  return path.join(root, 'active');
}

async function seedOwner(
  lockDir: string,
  owner: { pid: number; nonce: string; instanceName?: string },
): Promise<void> {
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
    ...owner,
    instanceName: owner.instanceName ?? 'seed',
    acquiredAt: Date.now(),
  }));
}

async function readOwner(lockDir: string): Promise<{ pid: number; nonce: string }> {
  return JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GatewayTurnLease', () => {
  it('allows only one independent client to hold the lease', async () => {
    const lockDir = await lockPath();
    const first = createGatewayTurnLease({
      lockDir,
      pid: 101,
      instanceName: 'prospecting',
      isProcessAlive: () => true,
      pollMs: 5,
    });
    const second = createGatewayTurnLease({
      lockDir,
      pid: 202,
      instanceName: 'inbound',
      isProcessAlive: () => true,
      pollMs: 5,
    });

    const held = await first.acquire();
    let secondEntered = false;
    const waiting = second.acquire().then((handle) => {
      secondEntered = true;
      return handle;
    });

    await delay(25);
    expect(secondEntered).toBe(false);
    await held.release();
    const next = await waiting;
    expect(secondEntered).toBe(true);
    await next.release();
  });

  it('recovers a lease whose owner process is dead', async () => {
    const lockDir = await lockPath();
    await seedOwner(lockDir, { pid: 101, nonce: 'old' });
    const lease = createGatewayTurnLease({
      lockDir,
      pid: 202,
      instanceName: 'voice',
      isProcessAlive: (pid) => pid !== 101,
      pollMs: 5,
    });

    const handle = await lease.acquire();
    expect(await readOwner(lockDir)).toMatchObject({ pid: 202 });
    await handle.release();
  });

  it('does not remove a replacement lease when an old handle releases', async () => {
    const lockDir = await lockPath();
    const first = createGatewayTurnLease({
      lockDir,
      pid: 101,
      instanceName: 'prospecting',
      isProcessAlive: () => true,
    });
    const old = await first.acquire();

    await rm(lockDir, { recursive: true, force: true });
    await seedOwner(lockDir, { pid: 202, nonce: 'new-owner' });
    await old.release();

    expect(await readOwner(lockDir)).toMatchObject({ pid: 202, nonce: 'new-owner' });
  });

  it('cancels a queued acquisition without touching the active owner', async () => {
    const lockDir = await lockPath();
    const first = createGatewayTurnLease({
      lockDir,
      pid: 101,
      instanceName: 'prospecting',
      isProcessAlive: () => true,
      pollMs: 5,
    });
    const second = createGatewayTurnLease({
      lockDir,
      pid: 202,
      instanceName: 'voice',
      isProcessAlive: () => true,
      pollMs: 5,
    });
    const held = await first.acquire();
    let cancelled = false;
    const waiting = second.acquire({ cancelled: () => cancelled });

    await delay(10);
    cancelled = true;
    await expect(waiting).rejects.toThrow('gateway turn lease acquisition cancelled');
    expect(await readOwner(lockDir)).toMatchObject({ pid: 101 });
    await held.release();
  });
});
