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
  slotDir: string,
  owner: { pid: number; nonce: string; instanceName?: string },
): Promise<void> {
  await mkdir(slotDir, { recursive: true });
  await writeFile(path.join(slotDir, 'owner.json'), JSON.stringify({
    ...owner,
    instanceName: owner.instanceName ?? 'seed',
    acquiredAt: Date.now(),
  }));
}

function globalSlot(lockDir: string, slot = 0): string {
  return path.join(lockDir, 'global', `slot-${slot}`);
}

function instanceSlot(lockDir: string, instanceName: string, slot = 0): string {
  const key = Buffer.from(instanceName, 'utf8').toString('base64url');
  return path.join(lockDir, 'instances', key, `slot-${slot}`);
}

async function readOwner(slotDir: string): Promise<{ pid: number; nonce: string }> {
  return JSON.parse(await readFile(path.join(slotDir, 'owner.json'), 'utf8'));
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
    await seedOwner(instanceSlot(lockDir, 'voice'), { pid: 101, nonce: 'old-instance' });
    await seedOwner(globalSlot(lockDir), { pid: 101, nonce: 'old' });
    const lease = createGatewayTurnLease({
      lockDir,
      pid: 202,
      instanceName: 'voice',
      isProcessAlive: (pid) => pid !== 101,
      pollMs: 5,
    });

    const handle = await lease.acquire();
    expect(await readOwner(globalSlot(lockDir))).toMatchObject({ pid: 202 });
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

    await rm(globalSlot(lockDir), { recursive: true, force: true });
    await seedOwner(globalSlot(lockDir), { pid: 202, nonce: 'new-owner' });
    await old.release();

    expect(await readOwner(globalSlot(lockDir))).toMatchObject({ pid: 202, nonce: 'new-owner' });
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
    expect(await readOwner(globalSlot(lockDir))).toMatchObject({ pid: 101 });
    await held.release();
  });

  it('allows three turns for one instance and queues its fourth', async () => {
    const lockDir = await lockPath();
    const leases = Array.from({ length: 4 }, (_, index) => createGatewayTurnLease({
      lockDir,
      pid: 300 + index,
      instanceName: 'marketing-prospecting',
      instanceCapacity: 3,
      globalCapacity: 15,
      isProcessAlive: () => true,
      pollMs: 5,
    }));
    const held = await Promise.all(leases.slice(0, 3).map((lease) => lease.acquire()));
    let fourthEntered = false;
    const fourth = leases[3].acquire().then((handle) => {
      fourthEntered = true;
      return handle;
    });

    await delay(25);
    expect(fourthEntered).toBe(false);
    await held[0].release();
    const fourthHandle = await fourth;
    expect(fourthEntered).toBe(true);
    await Promise.all([...held.slice(1), fourthHandle].map((handle) => handle.release()));
  });

  it('allows fifteen fleet turns and queues the sixteenth', async () => {
    const lockDir = await lockPath();
    const leases = Array.from({ length: 16 }, (_, index) => createGatewayTurnLease({
      lockDir,
      pid: 400 + index,
      instanceName: `bot-${index}`,
      instanceCapacity: 3,
      globalCapacity: 15,
      isProcessAlive: () => true,
      pollMs: 5,
    }));
    const held = await Promise.all(leases.slice(0, 15).map((lease) => lease.acquire()));
    let sixteenthEntered = false;
    const sixteenth = leases[15].acquire().then((handle) => {
      sixteenthEntered = true;
      return handle;
    });

    await delay(25);
    expect(sixteenthEntered).toBe(false);
    await held[0].release();
    const lastHandle = await sixteenth;
    expect(sixteenthEntered).toBe(true);
    await Promise.all([...held.slice(1), lastHandle].map((handle) => handle.release()));
  });

  it('releases an instance slot when cancelled while waiting for a global slot', async () => {
    const lockDir = await lockPath();
    const globalHolder = createGatewayTurnLease({
      lockDir, pid: 501, instanceName: 'holder', instanceCapacity: 1, globalCapacity: 1,
      isProcessAlive: () => true, pollMs: 5,
    });
    const waiting = createGatewayTurnLease({
      lockDir, pid: 502, instanceName: 'waiting', instanceCapacity: 1, globalCapacity: 1,
      isProcessAlive: () => true, pollMs: 5,
    });
    const replacement = createGatewayTurnLease({
      lockDir, pid: 503, instanceName: 'waiting', instanceCapacity: 1, globalCapacity: 1,
      isProcessAlive: () => true, pollMs: 5,
    });
    const held = await globalHolder.acquire();
    let cancelled = false;
    const blocked = waiting.acquire({ cancelled: () => cancelled });
    await delay(20);
    cancelled = true;
    await expect(blocked).rejects.toThrow('gateway turn lease acquisition cancelled');
    await held.release();

    const next = await replacement.acquire();
    await next.release();
  });
});
