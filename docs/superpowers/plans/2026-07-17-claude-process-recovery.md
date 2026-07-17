# Claude Process Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Survive transient Claude Code process exits with three total turn attempts while never automatically replaying a turn after a possible tool side effect.

**Architecture:** Claude Code keeps responsibility for request-level retry and the Nexcor adapter keeps responsibility for protocol compatibility. MessageBridge owns turn-level recovery: it starts a fresh Claude session after a safe process exit, waits with exponential backoff, and caps the turn at three total attempts. The existing completed-output recovery and side-effect stop policy remain authoritative.

**Tech Stack:** TypeScript, Vitest, Claude Code PTY backend, MessageBridge.

## Global Constraints

- Do not retry `/v1/messages` inside the compatibility adapter.
- Permit at most three total turn attempts: initial attempt plus two safe replays.
- Replay only when `completedOutputRecovered=false`, `sideEffectSeen=false`, and the user has not stopped the turn.
- Use fresh sessions for replays and exponential delays of 500 ms then 1000 ms.
- Cover both startup failures and failures raised while consuming the turn stream.

---

### Task 1: Recovery policy

**Files:**
- Modify: `src/bridge/claude-turn-recovery.ts`
- Test: `tests/claude-turn-recovery.test.ts`

- [ ] Write a failing test proving replay counts 0 and 1 are retryable and replay count 2 stops.
- [ ] Add the three-attempt cap and exponential delay calculation.
- [ ] Run `vitest run tests/claude-turn-recovery.test.ts` and confirm it passes.

### Task 2: MessageBridge safe replay loop

**Files:**
- Modify: `src/bridge/message-bridge.ts`
- Test: `tests/message-bridge.test.ts`

- [ ] Change the existing process-exit test to crash twice before succeeding and verify three executions.
- [ ] Replace single fresh-session replay branches with capped loops using the shared policy and backoff.
- [ ] Verify a tool-side-effect exit still runs exactly once.
- [ ] Run `vitest run tests/message-bridge.test.ts tests/claude-turn-recovery.test.ts`.

### Task 3: Regression and deployment

**Files:**
- No additional source files.

- [ ] Run the complete MetaBot test suite and TypeScript build.
- [ ] Commit and merge the isolated branch.
- [ ] Deploy through the existing AgentOS deployment gate.
- [ ] Run concurrent Claude smoke tests and verify no process-exit error.
