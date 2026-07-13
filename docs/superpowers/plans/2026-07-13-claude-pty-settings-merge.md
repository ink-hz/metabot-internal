# Claude PTY Settings Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Claude user settings when MetaBot generates PTY hook settings, while keeping copied credentials private.

**Architecture:** Extend `createHookBridge()` with an injectable source-settings path for deterministic tests. Parse a valid object as the base configuration, append MetaBot hook entries by event name, and write the generated settings inside a private temporary directory.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, Claude Code 2.1.207, node-pty 1.1.0.

## Global Constraints

- Do not change Feishu bot configuration, model selection, backend selection, or Claude credentials.
- Missing, invalid, or non-object user settings must fall back to hooks-only settings.
- Generated bridge directories must use mode `0700`; generated settings files must use mode `0600`.
- Production deployment happens only after unit, build, CLI, and real PTY smoke tests pass locally.

---

### Task 1: Merge user settings into PTY hook settings

**Files:**
- Create: `tests/pty-hook-bridge.test.ts`
- Modify: `src/engines/claude/pty/hook-bridge.ts`

**Interfaces:**
- Consumes: `createHookBridge(options?: HookBridgeOptions)`.
- Produces: `HookBridgeOptions.sourceSettingsPath?: string`; `writeSettings()` returns the private generated JSON path.

- [ ] **Step 1: Write failing tests**

Create tests using `mkdtempSync()` and a source settings file. Assert that a custom field and existing `Stop` hook survive, MetaBot adds a second `Stop` hook, and generated path modes are `0700`/`0600`. Add parameterized invalid-input cases for missing JSON, malformed JSON, arrays, and primitives; each must produce a hooks-only object with one MetaBot Stop hook.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/pty-hook-bridge.test.ts`

Expected: FAIL because `sourceSettingsPath` is not accepted and generated settings do not preserve the source fields.

- [ ] **Step 3: Implement the minimum merge**

Add `sourceSettingsPath?: string` to `HookBridgeOptions`, default it to `join(homedir(), '.claude', 'settings.json')`, and add a reader that returns `{}` for read/parse errors, arrays, null, and primitives. Build each hook array as `[...existingEntries, ...metabotEntries]`. Create the bridge directory with `{ recursive: true, mode: 0o700 }` and write JSON with `{ encoding: 'utf8', mode: 0o600 }`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/pty-hook-bridge.test.ts`

Expected: all hook-bridge tests PASS.

- [ ] **Step 5: Commit**

Run: `git add tests/pty-hook-bridge.test.ts src/engines/claude/pty/hook-bridge.ts && git commit -m "fix: preserve Claude settings in PTY sessions"`.

### Task 2: Verify the complete local PTY path

**Files:**
- Use: `scripts/smoke-pty.ts`
- Verify: `src/engines/claude/pty/hook-bridge.ts`

**Interfaces:**
- Consumes: local Claude arm64 executable and the patched `ptyQuery()` path.
- Produces: exact marker `METABOT_PTY_OK_713` from a live model turn.

- [ ] **Step 1: Run focused and existing tests**

Run: `npx vitest run tests/pty-hook-bridge.test.ts && npm run build:bridge && npm test`.

Expected: commands exit `0` with no test failures.

- [ ] **Step 2: Verify the Claude executable and direct CLI**

Run the local Claude executable with `--version`, then use `-p` to request marker `METABOT_CLI_OK_713`.

Expected: version `2.1.207` and exact marker response.

- [ ] **Step 3: Verify MetaBot's real PTY adapter**

Run: `./node_modules/.bin/tsx scripts/smoke-pty.ts`.

Expected: exact output marker `METABOT_PTY_OK_713` and exit `0`.

- [ ] **Step 4: Prepare one-shot runtime deployment**

Package the committed source patch plus a deployment script that backs up the runtime, installs the exact Claude native optional package, fixes `node-pty/prebuilds/darwin-arm64/spawn-helper` to mode `0755`, rebuilds MetaBot as `agentops`, restarts PM2, and rolls back on failed health or runtime smoke checks.

- [ ] **Step 5: Commit verification tooling**

Run: `git add scripts/smoke-pty.ts docs/superpowers && git commit -m "test: add Claude PTY deployment verification"`.
