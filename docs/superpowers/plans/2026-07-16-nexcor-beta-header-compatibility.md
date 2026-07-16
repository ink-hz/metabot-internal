# Nexcor Beta Header Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Claude Code 2.1.207 and Opus 4.8 working through Nexcor by removing only the two beta request-header values that the configured Bedrock route demonstrably rejects.

**Architecture:** Extend the existing versioned Nexcor compatibility profile with an immutable unsupported-beta declaration. The loopback adapter filters those values only for `/v1/messages`; the runtime passes profile policy into the adapter, while the Agent-Team runtime contract selects the profile for every Claude Bot through generated PM2 environment.

**Tech Stack:** TypeScript, Node.js HTTP, Vitest, Node test runner, Bash deployment, PM2, Claude Code 2.1.207.

## Global Constraints

- Keep model `claude-opus-4-8` and Claude Code `2.1.207`.
- Filter only `redact-thinking-2026-02-12` and `prompt-caching-scope-2026-01-05`.
- Preserve request bodies, response bytes, SSE order, accepted beta values, native tools, and PTY sessions.
- Do not add adapter-level retries or expose prompts, tokens, response text, or credentials in logs.
- Preserve the user's untracked `metabot-dev/.tools/` directory.

---

### Task 1: Profile-Driven Beta Header Filtering

**Files:**
- Modify: `src/engines/claude/compatibility/profile.ts`
- Modify: `src/engines/claude/compatibility/adapter.ts`
- Modify: `tests/claude-compatibility-profile.test.ts`
- Modify: `tests/claude-gateway-adapter.test.ts`

**Interfaces:**
- Consumes: `ClaudeCompatibilityProfile` and the incoming `anthropic-beta` header.
- Produces: `unsupportedRequestBetas: readonly string[]` and `ClaudeGatewayAdapterOptions.unsupportedRequestBetas?: readonly string[]`.

- [ ] **Step 1: Write failing profile and adapter tests**

Add assertions that `OPUS_PROFILE.unsupportedRequestBetas` is frozen and equals the two rejected flags. Add fake-upstream adapter tests that send accepted and rejected comma-separated values, require only rejected values to disappear, require the header to be absent when every value is rejected, and require an adapter without policy to preserve the original header.

- [ ] **Step 2: Verify the tests fail for missing policy/filtering**

Run: `npm run test:bridge -- tests/claude-compatibility-profile.test.ts tests/claude-gateway-adapter.test.ts`

Expected: FAIL because the profile property is missing and rejected values still reach the fake upstream.

- [ ] **Step 3: Implement the minimal profile and header filter**

Add to `OPUS_PROFILE`:

```ts
unsupportedRequestBetas: Object.freeze([
  'redact-thinking-2026-02-12',
  'prompt-caching-scope-2026-01-05',
] as const),
```

Add the optional adapter option and a helper that filters comma-separated segments by comparing `segment.trim()` against a `Set`. Return the original header object when there is no policy or no matching value. Apply the helper only in the `/v1/messages` proxy call; remove `anthropic-beta` only when no accepted segments remain.

- [ ] **Step 4: Verify focused tests pass**

Run: `npm run test:bridge -- tests/claude-compatibility-profile.test.ts tests/claude-gateway-adapter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the independently testable adapter change**

```bash
git add src/engines/claude/compatibility/profile.ts src/engines/claude/compatibility/adapter.ts tests/claude-compatibility-profile.test.ts tests/claude-gateway-adapter.test.ts
git commit -m "fix: filter unsupported Nexcor beta headers"
```

### Task 2: Pass Versioned Policy into the Adapter Runtime

**Files:**
- Modify: `src/engines/claude/compatibility/runtime.ts`
- Modify: `tests/claude-launch-compatibility.test.ts`

**Interfaces:**
- Consumes: `options.profile.unsupportedRequestBetas`.
- Produces: `startClaudeGatewayAdapter({ unsupportedRequestBetas })` while keeping child/settings environment behavior unchanged.

- [ ] **Step 1: Write the failing runtime wiring test**

Capture `unsupportedRequestBetas` in the fake `adapterStarter` and assert it equals `OPUS_PROFILE.unsupportedRequestBetas` alongside the existing upstream URL and token assertions.

- [ ] **Step 2: Verify the runtime test fails**

Run: `npm run test:bridge -- tests/claude-launch-compatibility.test.ts`

Expected: FAIL because runtime does not pass the policy.

- [ ] **Step 3: Add the single runtime wiring field**

```ts
const adapter = await adapterStarter({
  upstreamBaseUrl,
  authToken,
  unsupportedRequestBetas: options.profile.unsupportedRequestBetas,
  logger: options.logger,
});
```

- [ ] **Step 4: Verify focused and full bridge checks**

Run: `npm run test:bridge -- tests/claude-launch-compatibility.test.ts tests/claude-gateway-adapter.test.ts && npm run build:bridge && npm run lint`

Expected: all commands exit 0.

- [ ] **Step 5: Commit runtime wiring**

```bash
git add src/engines/claude/compatibility/runtime.ts tests/claude-launch-compatibility.test.ts
git commit -m "fix: apply gateway beta policy at runtime"
```

### Task 3: Make Profile Selection Durable in Agent-Team Deployment

**Files:**
- Modify: `/Users/neo/Developer/work/Orbbec-Agent-Team/deploy/metabot.runtime-contract.json`
- Modify: `/Users/neo/Developer/work/Orbbec-Agent-Team/scripts/reliability/runtime-contract.mjs`
- Modify: `/Users/neo/Developer/work/Orbbec-Agent-Team/scripts/reliability/generate-ecosystem.mjs`
- Modify: `/Users/neo/Developer/work/Orbbec-Agent-Team/scripts/reliability/tests/runtime-contract.test.mjs`
- Modify: `/Users/neo/Developer/work/Orbbec-Agent-Team/scripts/reliability/tests/deploy-gate.test.mjs`
- Modify: `/Users/neo/Developer/work/Orbbec-Agent-Team/scripts/deploy_metabot_pty_fix.sh`

**Interfaces:**
- Consumes: `contract.claude.compatibilityProfile`.
- Produces: PM2 environment `METABOT_CLAUDE_COMPAT_PROFILE=nexcor-opus-4-8-claude-code-2.1.207` and deployment of all changed compatibility source files.

- [ ] **Step 1: Write failing contract and ecosystem tests**

Require the checked contract to contain the exact profile, require `allowedEnvironment` to include `METABOT_CLAUDE_COMPAT_PROFILE`, require generated PM2 environment to carry the exact value, and require runtime comparison to flag a different or missing value as `config_drift` on `claude.compatibility_profile`.

- [ ] **Step 2: Verify the Agent-Team tests fail**

Run: `node --test scripts/reliability/tests/runtime-contract.test.mjs scripts/reliability/tests/deploy-gate.test.mjs`

Expected: FAIL because the contract and PM2 generator do not yet select the profile.

- [ ] **Step 3: Implement contract, generator, and deployment source coverage**

Add `"compatibilityProfile": "nexcor-opus-4-8-claude-code-2.1.207"` under `claude`, add `METABOT_CLAUDE_COMPAT_PROFILE` to `allowedEnvironment`, emit it in `buildPm2Environment`, validate/compare the exact value, and add these paths to `SOURCE_FILES`:

```text
src/engines/claude/compatibility/adapter.ts
src/engines/claude/compatibility/profile.ts
src/engines/claude/compatibility/runtime.ts
```

- [ ] **Step 4: Verify Agent-Team focused and full tests**

Run: `node --test scripts/reliability/tests/runtime-contract.test.mjs scripts/reliability/tests/deploy-gate.test.mjs && node --test scripts/reliability/tests/*.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit deployment durability changes**

```bash
git add deploy/metabot.runtime-contract.json scripts/reliability/runtime-contract.mjs scripts/reliability/generate-ecosystem.mjs scripts/reliability/tests scripts/deploy_metabot_pty_fix.sh
git commit -m "fix: select Nexcor compatibility profile in production"
```

### Task 4: Merge, Deploy, and Reproduce the Original Turn

**Files:**
- Deploy from: `/Users/neo/Developer/work/metabot-dev`
- Deploy with: `/Users/neo/Developer/work/Orbbec-Agent-Team/scripts/deploy_metabot_pty_fix.sh`
- Verify runtime: `/Users/agentops/AgentRuntime/metabot`

**Interfaces:**
- Consumes: merged MetaBot and Agent-Team main/master commits.
- Produces: one restarted production MetaBot with the compatibility profile active for all seven configured Feishu connections.

- [ ] **Step 1: Run full pre-merge verification in both repositories**

Run MetaBot: `npm run test:bridge && npm run build:bridge && npm run lint`

Run Agent-Team: `npm test`

Expected: all exit 0.

- [ ] **Step 2: Merge both isolated feature branches locally**

Merge MetaBot into `main` and Agent-Team into `master`, rerun their full tests, then remove only the worktrees created for this repair.

- [ ] **Step 3: Deploy with automatic backup and rollback**

Run as the authorized local operator: `scripts/deploy_metabot_pty_fix.sh`.

Expected: `DEPLOY_OK`, health healthy, PTY marker present, and generated ecosystem containing the exact non-secret profile selector.

- [ ] **Step 4: Verify Test Bot through the real shared runtime**

Send `介绍下自己` to `test-bot` through authenticated local `/api/talk` with `sendCards:false`. Require `success:true`, non-empty assistant text, model `claude-opus-4-8` in the transcript, and no `invalid beta flag` in that session.

- [ ] **Step 5: Verify Marketing Prospecting Bot and production identity**

Send `介绍下自己` to `marketing-prospecting-bot` through the same runtime. Require a non-empty role-correct Prospecting answer, no terminal API error, seven WebSocket clients ready after restart, and logs showing `Claude compatibility runtime started` with the exact profile ID.

- [ ] **Step 6: Record final evidence**

Report both Bot results, test counts, merged commit IDs, deployment backup path, active profile ID, and any remaining external Nexcor limitation without printing credentials or full private logs.
