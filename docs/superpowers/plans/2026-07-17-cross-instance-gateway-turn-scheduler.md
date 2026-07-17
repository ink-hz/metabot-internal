# Cross-instance Gateway Turn Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize active Claude PTY turns across independently running MetaBot processes so simultaneous Marketing Bot mentions queue and complete instead of crashing at the shared Nexcor gateway.

**Architecture:** A file-backed lease module uses atomic directory creation for mutual exclusion and PID/nonce ownership for safe crash recovery. `ptyQuery` acquires the shared lease immediately before submitting a prompt and releases it on every terminal path; the PM2 fleet gives every PTY instance the same protected lock directory.

**Tech Stack:** TypeScript, Node.js filesystem primitives, Vitest, Bash, PM2, macOS `agentops` runtime.

## Global Constraints

- Keep one shared MetaBot source and Release SHA; do not fork code per Bot.
- Keep the `nexcor-opus-4-8-claude-code-2.1.207` compatibility Profile unchanged.
- Apply scheduling only to PTY turns; SDK Bots remain unchanged.
- Never steal a lease owned by a live process.
- Never persist credentials, prompts, chat IDs, or customer content in the lease.
- Do not automatically replay after a tool side effect.

---

### Task 1: File-backed gateway turn lease

**Files:**
- Create: `src/engines/claude/pty/gateway-turn-lease.ts`
- Create: `tests/gateway-turn-lease.test.ts`

**Interfaces:**
- Produces: `GatewayTurnLease.acquire(options?: { cancelled?: () => boolean }): Promise<GatewayTurnLeaseHandle>`
- Produces: `GatewayTurnLeaseHandle.release(): Promise<void>`
- Produces: `createGatewayTurnLease(options: GatewayTurnLeaseOptions): GatewayTurnLease`

- [ ] **Step 1: Write failing mutual-exclusion and recovery tests**

```ts
it('allows only one independent client to hold the lease', async () => {
  const first = createGatewayTurnLease({ lockDir, pid: 101, isProcessAlive: () => true });
  const second = createGatewayTurnLease({ lockDir, pid: 202, isProcessAlive: () => true, pollMs: 5 });
  const held = await first.acquire();
  let secondEntered = false;
  const waiting = second.acquire().then((handle) => { secondEntered = true; return handle; });
  await delay(20);
  expect(secondEntered).toBe(false);
  await held.release();
  const next = await waiting;
  expect(secondEntered).toBe(true);
  await next.release();
});

it('recovers a lease whose owner process is dead', async () => {
  await seedOwner(lockDir, { pid: 101, nonce: 'old' });
  const lease = createGatewayTurnLease({ lockDir, pid: 202, isProcessAlive: () => false });
  const handle = await lease.acquire();
  await handle.release();
});

it('does not remove a replacement lease when an old handle releases', async () => {
  const old = await first.acquire();
  await replaceOwnerForTest(lockDir, { pid: 202, nonce: 'new' });
  await old.release();
  expect(await readOwner(lockDir)).toMatchObject({ nonce: 'new' });
});

it('cancels a queued acquisition without touching the owner', async () => {
  const held = await first.acquire();
  let cancelled = false;
  const waiting = second.acquire({ cancelled: () => cancelled });
  cancelled = true;
  await expect(waiting).rejects.toThrow('gateway turn lease acquisition cancelled');
  expect(await readOwner(lockDir)).toMatchObject({ pid: 101 });
  await held.release();
});
```

- [ ] **Step 2: Run the lease tests and verify RED**

Run: `npx vitest run tests/gateway-turn-lease.test.ts`

Expected: FAIL because `gateway-turn-lease.ts` does not exist.

- [ ] **Step 3: Implement atomic ownership**

```ts
export interface GatewayTurnLeaseHandle { release(): Promise<void> }
export interface GatewayTurnLease {
  acquire(options?: { cancelled?: () => boolean }): Promise<GatewayTurnLeaseHandle>;
}

export function createGatewayTurnLease(options: GatewayTurnLeaseOptions): GatewayTurnLease {
  return {
    async acquire({ cancelled = () => false } = {}) {
      while (!cancelled()) {
        const nonce = randomUUID();
        try {
          await mkdir(options.lockDir);
          await writeFile(ownerPath(options.lockDir), JSON.stringify({ pid, nonce, instanceName, acquiredAt: Date.now() }), { mode: 0o600 });
          return nonceCheckedHandle(options.lockDir, nonce);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          await reclaimOnlyIfOwnerPidIsDead(options);
          await delay(options.pollMs ?? 200);
        }
      }
      throw new Error('gateway turn lease acquisition cancelled');
    },
  };
}
```

Use atomic rename-to-quarantine before deleting a stale lock. A release must read `owner.json`, compare its nonce, rename the owned directory to a unique release path, and only then remove it.

- [ ] **Step 4: Run focused and related tests**

Run: `npx vitest run tests/gateway-turn-lease.test.ts tests/pty-process-exit.test.ts tests/pty-turn-recovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engines/claude/pty/gateway-turn-lease.ts tests/gateway-turn-lease.test.ts
git commit -m "feat: coordinate Claude gateway turns across processes"
```

### Task 2: PTY turn lifecycle integration

**Files:**
- Modify: `src/engines/claude/pty/contract.ts`
- Modify: `src/engines/claude/pty/pty-query.ts`
- Modify: `src/engines/claude/persistent-executor.ts`
- Create: `tests/pty-gateway-turn-lease.test.ts`

**Interfaces:**
- Consumes: `GatewayTurnLease` from Task 1.
- Adds: `PtyQueryOptions.gatewayTurnLease?: GatewayTurnLease`.
- Adds: production construction from `METABOT_CLAUDE_GATEWAY_LOCK_DIR`.

- [ ] **Step 1: Write a failing PTY lifecycle test**

Inject a fake lease and fake PTY session. Assert that `typePrompt` does not run until acquisition resolves, and that the same handle is released exactly once for Stop completion, terminal API error, slash synthetic completion, interrupt, unexpected exit, and dispose.

```ts
expect(events).toEqual(['acquire:start']);
releaseAcquire();
await submitted;
expect(events).toEqual(['acquire:start', 'acquire:done', 'typePrompt']);
completeTurn();
expect(release).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `npx vitest run tests/pty-gateway-turn-lease.test.ts`

Expected: FAIL because `PtyQueryOptions` has no gateway lease and prompts are submitted immediately.

- [ ] **Step 3: Acquire before dispatch and centralize idempotent release**

```ts
let activeGatewayLease: GatewayTurnLeaseHandle | undefined;

async function releaseGatewayTurn(): Promise<void> {
  const held = activeGatewayLease;
  activeGatewayLease = undefined;
  if (held) await held.release();
}

async function acquireGatewayTurn(): Promise<boolean> {
  const lease = options.gatewayTurnLease;
  if (!lease) return true;
  activeGatewayLease = await lease.acquire({ cancelled: () => disposed });
  return !disposed;
}
```

Call `acquireGatewayTurn()` immediately before marking the turn dispatched and calling `session.typePrompt(text)`. Invoke `void releaseGatewayTurn()` on every terminal path named in the design. If submission itself throws, release before propagating the failure.

- [ ] **Step 4: Construct the production lease only for PTY**

```ts
const lockDir = process.env.METABOT_CLAUDE_GATEWAY_LOCK_DIR?.trim();
const gatewayTurnLease = lockDir
  ? createGatewayTurnLease({
      lockDir,
      instanceName: process.env.METABOT_INSTANCE_NAME,
    })
  : undefined;
```

Pass it into `PtyQueryOptions`. Do not construct or pass it on the SDK branch.

- [ ] **Step 5: Run focused tests and the complete MetaBot suite**

Run: `npx vitest run tests/pty-gateway-turn-lease.test.ts tests/gateway-turn-lease.test.ts tests/persistent-executor-process-exit.test.ts tests/message-bridge.test.ts`

Run: `npm run test:bridge && npm run build:bridge`

Expected: all tests and TypeScript build PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engines/claude/pty/contract.ts src/engines/claude/pty/pty-query.ts src/engines/claude/persistent-executor.ts tests/pty-gateway-turn-lease.test.ts
git commit -m "fix: serialize active PTY turns at the shared gateway"
```

### Task 3: Fleet contract, deployment, and production acceptance

**Files:**
- Modify in Orbbec Agent Team: `deploy/metabot.runtime-contract.json`
- Modify in Orbbec Agent Team: `scripts/reliability/generate-ecosystem.mjs`
- Modify in Orbbec Agent Team: `scripts/reliability/generate-instance-configs.mjs`
- Modify in Orbbec Agent Team: `scripts/deploy_metabot_pty_fix.sh`
- Modify in Orbbec Agent Team: `scripts/reliability/tests/deploy-gate.test.mjs`
- Modify in Orbbec Agent Team: `scripts/reliability/tests/runtime-contract.test.mjs`

**Interfaces:**
- Consumes: `METABOT_CLAUDE_GATEWAY_LOCK_DIR` from Task 2.
- Produces: one shared `/Users/agentops/AgentRuntime/locks/claude-gateway` active-lock path; its `/Users/agentops/AgentRuntime/locks` parent is owned by `agentops`, mode `0700`.

- [ ] **Step 1: Write failing contract and ecosystem tests**

```js
assert.equal(contract.claude.gatewayTurnLockDir, '/Users/agentops/AgentRuntime/locks/claude-gateway');
for (const app of generated.apps.filter((item) => item.env.METABOT_ONLY_BOTS !== 'feishu-default' && item.env.METABOT_ONLY_BOTS !== 'fae-bot')) {
  assert.equal(app.env.METABOT_CLAUDE_GATEWAY_LOCK_DIR, contract.claude.gatewayTurnLockDir);
}
assert.equal(defaultApp.env.METABOT_CLAUDE_GATEWAY_LOCK_DIR, undefined);
assert.equal(faeApp.env.METABOT_CLAUDE_GATEWAY_LOCK_DIR, undefined);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/reliability/tests/runtime-contract.test.mjs scripts/reliability/tests/deploy-gate.test.mjs`

Expected: FAIL because the contract and generated PTY environment lack the shared lock directory.

- [ ] **Step 3: Add the protected shared lock directory**

Add `claude.gatewayTurnLockDir` to schema validation. Generate `METABOT_CLAUDE_GATEWAY_LOCK_DIR` only when `bot.backend === 'pty'`. During deployment create only its parent as `agentops:staff` mode `0700`; the lease module creates and removes the active-lock path.

- [ ] **Step 4: Verify all repository tests**

Run: `node --test scripts/reliability/tests/*.test.mjs`

Run: `bash -n scripts/deploy_metabot_pty_fix.sh scripts/reliability/sanitized-pm2.sh`

Expected: all tests and shell syntax PASS.

- [ ] **Step 5: Commit and merge both repositories**

```bash
git add deploy scripts
git commit -m "feat: configure shared Claude gateway turn scheduling"
```

Merge the MetaBot and Orbbec Agent Team feature branches into their respective `master` branches only after clean test runs.

- [ ] **Step 6: Deploy once and verify real concurrency**

Deploy one shared MetaBot Release to all seven PM2 instances. Verify Test Bot first, then the production fleet. Send the same introduction prompt simultaneously to Prospecting, Inbound, and Voice through the real Feishu group path.

Acceptance evidence:

```text
marketing-prospecting-bot terminal=complete
marketing-inbound-bot terminal=complete
marketing-voice-bot terminal=complete
claude_process_exit=0
max_active_gateway_turns=1
shared_release_sha=<same nonempty SHA for all seven instances>
compatibility_profile=nexcor-opus-4-8-claude-code-2.1.207
```

Do not declare success from PM2 `online`, `/api/health`, or sequential `/api/talk` alone.
