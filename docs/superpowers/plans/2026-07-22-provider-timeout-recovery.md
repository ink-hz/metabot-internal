# Provider Timeout Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with review checkpoints. In this session the primary agent executes it inline because delegation was not requested.

**Goal:** Make transient Claude/provider failures visible, correctly classified, safely retryable once, and guaranteed to leave every PTY/API task in a terminal state.

**Architecture:** Preserve a bounded provider-error envelope at the PTY boundary, convert it into the existing SDK-compatible result stream, and let a pure recovery policy decide whether a fresh-session replay is safe. The coordinator owns replay because only it can see user cancellation and tool effects; the HTTP compatibility adapter remains non-retrying and gains transport lifecycle telemetry. A longer provider request ceiling remains a separately verified deployment setting, not the primary recovery mechanism.

**Tech Stack:** TypeScript, Node.js HTTP/HTTPS and PTY adapters, Vitest, existing MessageBridge/StreamProcessor/SessionManager abstractions.

## Global Constraints

- Follow red-green-refactor for every behavior change: add one focused failing test, observe the expected failure, implement the minimum change, then rerun the focused suite.
- Never log request bodies, prompts, authorization values, raw terminal screens, or unrestricted upstream responses.
- Automatic replay is limited to one retry (two total attempts) and always starts a fresh Claude session.
- Unknown or external tool effects block replay. The gateway HTTP adapter never retries POST requests.
- Do not increase the effective 300-second provider timeout until the upstream/proxy stream-lifetime contract is verified independently.

---

### Task 1: Preserve a sanitized provider error through PTY result synthesis

**Files:**

- Create: `src/engines/claude/pty/provider-error.ts`
- Modify: `src/engines/claude/pty/contract.ts`
- Modify: `src/engines/claude/pty/message-adapter.ts`
- Modify: `src/engines/claude/pty/pty-query.ts`
- Test: `tests/pty-provider-error.test.ts`

**Step 1: Write failing tests**

Cover these cases:

```ts
expect(extractProviderError({
  type: 'assistant',
  isApiErrorMessage: true,
  apiErrorStatus: 504,
  message: { content: [{ type: 'text', text: 'API Error: The operation timed out.' }] },
})).toEqual({ kind: 'api_error', status: 504, message: 'API Error: The operation timed out.' });

expect(extractProviderError(recordContainingBearerToken).message).not.toContain('secret');
expect(synthesizeResult({ sessionId: 's', isError: true, errors: ['API Error: timed out'] }).errors)
  .toEqual(['API Error: timed out']);
```

Also prove messages are capped at 500 characters and absent/structured content falls back to a bounded generic provider message.

**Step 2: Run the focused test and observe RED**

Run: `npx vitest run tests/pty-provider-error.test.ts`

Expected: module/export and `errors` contract assertions fail because no provider envelope is currently preserved.

**Step 3: Implement the minimum sanitizer and result plumbing**

- Extract only `kind`, numeric `status`, and text content.
- Replace bearer/API-key/token-shaped secrets with `[REDACTED]`, collapse whitespace, and cap at 500 characters.
- Add `errors?: string[]` to `SynthesizeResultArgs` and copy a bounded list into `SDKMessage.errors`.
- In `runScanner`, pass the extracted provider error to `synthesizeResult` instead of dropping it.

**Step 4: Run GREEN and regression tests**

Run:

```bash
npx vitest run tests/pty-provider-error.test.ts tests/stream-processor.test.ts
```

Expected: both suites pass; the stream processor receives the real sanitized timeout text.

**Step 5: Commit**

```bash
git add src/engines/claude/pty/provider-error.ts src/engines/claude/pty/contract.ts src/engines/claude/pty/message-adapter.ts src/engines/claude/pty/pty-query.ts tests/pty-provider-error.test.ts
git commit -m "fix: preserve sanitized Claude provider errors"
```

---

### Task 2: Classify provider failures with stable public codes

**Files:**

- Modify: `src/reliability/public-error.ts`
- Modify: `tests/public-error.test.ts`

**Step 1: Extend failing classification tests**

Add assertions for:

- `API Error: The operation timed out.` -> `timeout` -> `TASK_TIMEOUT`.
- HTTP 429 / capacity text -> `gateway_transport` -> `MODEL_GATEWAY_UNAVAILABLE`.
- HTTP 502, 503, 504 and connection-reset variants -> `gateway_transport`.
- an otherwise unrecognized `API Error:` -> `provider_error` -> `MODEL_PROVIDER_ERROR`.
- malformed request, authentication, model mismatch, and invalid session remain non-generic and non-retryable.

**Step 2: Run RED**

Run: `npx vitest run tests/public-error.test.ts`

Expected: 429 and unknown provider cases fail under the current classifier.

**Step 3: Implement deterministic ordering**

- Add `provider_error` to `RELIABILITY_ERROR_CLASSES` and `PUBLIC_ERRORS`.
- Keep specific session/model/capability rules before generic provider rules.
- Recognize 429/capacity and 5xx transport shapes before the final `API Error` fallback.
- Do not map 400/auth/permission failures to a retryable transport class.

**Step 4: Run GREEN**

Run: `npx vitest run tests/public-error.test.ts tests/task-routes-reliability.test.ts`

**Step 5: Commit**

```bash
git add src/reliability/public-error.ts tests/public-error.test.ts
git commit -m "fix: classify model provider failures"
```

---

### Task 3: Guarantee PTY startup and prompt-loop terminalization

**Files:**

- Modify: `src/engines/claude/pty/pty-query.ts`
- Modify: `src/engines/claude/pty/process-exit.ts` if a more general typed failure is required
- Test: `tests/pty-process-exit.test.ts`
- Test: `tests/pty-turn-recovery.test.ts`

**Step 1: Write failing lifecycle tests**

Using the existing PTY/session fakes, prove:

- a readiness rejection reaches the async stream consumer as a typed failure;
- a `typePrompt` rejection reaches the consumer and closes the output queue;
- cleanup executes once and the stream cannot remain open after either failure.

**Step 2: Run RED**

Run: `npx vitest run tests/pty-process-exit.test.ts tests/pty-turn-recovery.test.ts`

Expected: prompt-loop errors are only logged/disposed and therefore fail the terminalization assertion.

**Step 3: Implement one terminal failure path**

- Add an idempotent `failTurn(error, phase)` helper near the PTY output queue.
- On scanner, boot, or prompt-loop failure: release the gateway lease, mark the turn not in flight, fail the output queue with bounded typed phase metadata, and dispose exactly once.
- Preserve `toolSideEffectSeen` in the typed error so the coordinator can reject unsafe replay.

**Step 4: Run GREEN and process-exit regressions**

Run:

```bash
npx vitest run tests/pty-process-exit.test.ts tests/pty-turn-recovery.test.ts tests/persistent-executor-process-exit.test.ts tests/persistent-executor-abort.test.ts
```

**Step 5: Commit**

```bash
git add src/engines/claude/pty/pty-query.ts src/engines/claude/pty/process-exit.ts tests/pty-process-exit.test.ts tests/pty-turn-recovery.test.ts
git commit -m "fix: terminalize PTY loop failures"
```

---

### Task 4: Classify tool effects and define the one-retry policy

**Files:**

- Create: `src/bridge/tool-effect.ts`
- Create: `src/bridge/provider-turn-recovery.ts`
- Modify: `src/bridge/claude-turn-recovery.ts`
- Test: `tests/tool-effect.test.ts`
- Test: `tests/provider-turn-recovery.test.ts`
- Modify: `tests/claude-turn-recovery.test.ts`

**Step 1: Write failing pure-function tests**

Prove:

- `Read`, `Glob`, `Grep`, and conservative inspection-only Bash commands are `read_only`.
- writes, uploads, messaging, network mutation, shell redirection/pipelines, command substitution, and unknown tools are `external_side_effect` for replay purposes.
- timeout/429/gateway transport with only read-only effects and retry count 0 returns `replay_fresh_once`.
- retry count 1, cancellation, usable terminal answer, or external/unknown effect returns `stop_without_replay`.
- process-exit recovery consumes the same effect semantics and is capped at two total attempts.

**Step 2: Run RED**

Run:

```bash
npx vitest run tests/tool-effect.test.ts tests/provider-turn-recovery.test.ts tests/claude-turn-recovery.test.ts
```

**Step 3: Implement conservative pure policies**

- Define `ToolEffect = 'read_only' | 'local_idempotent' | 'external_side_effect'`.
- Default unknown tools/commands to `external_side_effect`.
- Keep the initial Bash allowlist deliberately small (`pwd`, `ls`, `which`, `command -v`, `file`, `stat`, `wc`, `head`, `tail`, `rg`, `git status|log|diff|show`, and version probes) and reject shell control/redirection tokens.
- Define transient provider classes and cap replay at one retry with 2-5 second deterministic/jitterable backoff input.
- Align `MAX_CLAUDE_TURN_ATTEMPTS` to two total attempts.

**Step 4: Run GREEN**

Run the three focused suites from Step 2.

**Step 5: Commit**

```bash
git add src/bridge/tool-effect.ts src/bridge/provider-turn-recovery.ts src/bridge/claude-turn-recovery.ts tests/tool-effect.test.ts tests/provider-turn-recovery.test.ts tests/claude-turn-recovery.test.ts
git commit -m "feat: add safe provider turn recovery policy"
```

---

### Task 5: Integrate one fresh-session replay in MessageBridge

**Files:**

- Modify: `src/engines/claude/stream-processor.ts`
- Modify: `src/bridge/message-bridge.ts`
- Modify: `tests/message-bridge.test.ts`
- Modify: `tests/stream-processor.test.ts`

**Step 1: Write failing integration tests**

Add API-task and Feishu-path cases that inject result messages rather than HTTP retries:

- first attempt emits timeout result before side effects; bridge resets the active session mapping, creates one fresh execution handle, and completes;
- two timeout results produce exactly two attempts and a terminal failure;
- a timeout after an external/unknown tool does not replay;
- a resumed session readiness failure receives one fresh-session fallback;
- final task activity and callback/card state are emitted exactly once.

**Step 2: Run RED**

Run: `npx vitest run tests/message-bridge.test.ts tests/stream-processor.test.ts`

Expected: provider-result failures currently leave the normal error path without a fresh replay.

**Step 3: Expose turn evidence from StreamProcessor**

- Track top-level tool names/inputs for the current attempt without persisting prompt bodies.
- Expose a bounded `getTurnRecoveryEvidence()` value containing `hasUsableAnswer` and the strongest tool effect.
- Reset attempt-local evidence before replay while preserving user-visible accumulated state only when safe.

**Step 4: Refactor coordinator consumption into one helper**

- Route normal terminal error results and thrown PTY failures through the same provider recovery decision.
- Finish the failed handle, reset only the active session mapping, wait the capped backoff, and invoke `runOneTurn(... freshSession: true)`.
- Reuse the existing stream-consumption/card update path so the second attempt cannot bypass terminal activity, delivery, or cleanup logic.
- Emit structured logs with class, attempt number, phase, and effect only.

**Step 5: Run GREEN and adjacent regressions**

Run:

```bash
npx vitest run tests/message-bridge.test.ts tests/stream-processor.test.ts tests/session-manager.test.ts tests/gateway-turn-lease.test.ts tests/final-delivery-receipt.test.ts
```

**Step 6: Commit**

```bash
git add src/engines/claude/stream-processor.ts src/bridge/message-bridge.ts tests/message-bridge.test.ts tests/stream-processor.test.ts
git commit -m "feat: retry transient provider turns once"
```

---

### Task 6: Add gateway stream lifecycle observability without POST retry

**Files:**

- Modify: `src/engines/claude/compatibility/adapter.ts`
- Modify: `tests/claude-gateway-adapter.test.ts`

**Step 1: Write failing telemetry tests**

Simulate an upstream SSE response that sends one chunk and then destroys the socket. Assert one bounded terminal warning includes `response_aborted`, duration, byte count, and idle milliseconds, while captured logs exclude request content and token values. Retain the assertion that an unavailable upstream receives one POST only.

**Step 2: Run RED**

Run: `npx vitest run tests/claude-gateway-adapter.test.ts`

**Step 3: Implement lifecycle accounting**

- Log request start with method/path/request bytes.
- Count response bytes and update `lastChunkAt` on data.
- Log exactly one terminal event for finish, upstream abort/premature close, upstream request error, or downstream close.
- Do not add adapter retries or dump URLs with query secrets.

**Step 4: Run GREEN**

Run the focused adapter suite.

**Step 5: Commit**

```bash
git add src/engines/claude/compatibility/adapter.ts tests/claude-gateway-adapter.test.ts
git commit -m "feat: observe gateway stream termination"
```

---

### Task 7: Document and verify the timeout rollout contract

**Files:**

- Create: `scripts/verify-provider-stream-lifetime.ts`
- Modify: `package.json`
- Modify: `.env.example` if the effective timeout is repository-managed
- Create: `docs/operations/provider-timeout-recovery.md`
- Test: `tests/provider-stream-lifetime.test.ts`

**Step 1: Write failing configuration/probe tests**

Prove the probe reports success only when a sanitized synthetic stream remains alive for the requested duration or receives heartbeats within 60 seconds. Prove it prints no token and does not mutate Claude settings.

**Step 2: Run RED, implement, and run GREEN**

Run:

```bash
npx vitest run tests/provider-stream-lifetime.test.ts
npm run probe:provider-stream-lifetime -- --dry-run
```

The operations document must state that `API_TIMEOUT_MS=600000` may be deployed only after a real probe passes through the same upstream and proxies. Until then production remains at 300000 ms.

**Step 3: Commit**

```bash
git add scripts/verify-provider-stream-lifetime.ts package.json .env.example docs/operations/provider-timeout-recovery.md tests/provider-stream-lifetime.test.ts
git commit -m "docs: gate provider timeout increase on stream probe"
```

---

### Task 8: Full verification and handoff

**Step 1: Run repository checks from a clean command invocation**

```bash
npm test
npm run lint
npm run build:bridge
git diff --check
git status --short
```

**Step 2: Inspect the diff for safety invariants**

- No credentials, prompts, or customer content in fixtures/log strings.
- No POST retry in the HTTP adapter.
- Exactly one coordinator retry and a fresh session reset.
- Every PTY loop exception fails or terminates the output stream.
- Existing user files and the unrelated `.tools/` directory remain untouched.

**Step 3: Production rollout checkpoint**

Do not deploy from the implementation session without explicit authorization. Report:

- branch/worktree path and commits;
- focused and full test evidence;
- whether the real upstream stream-lifetime probe has run;
- whether the 600-second ceiling is still gated;
- the isolated GTM staging smoke procedure from the approved design spec.
