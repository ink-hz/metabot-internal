# Opus Native Web Tools Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Claude Code's native `WebSearch` and `WebFetch` exposed, preserve their wire format through the compatibility adapter, and deliver Claude's completed explanation when an upstream tool failure is recoverable.

**Architecture:** Native web tools remain owned by Claude Code and the configured gateway. The compatibility adapter performs byte-for-byte pass-through for every non-image request, PTY recovery trusts only top-level `end_turn` assistant text, and the capability probe reports current upstream status without toggling tools or injecting a replacement provider.

**Tech Stack:** TypeScript 5.9, Claude Code 2.1.207, Anthropic Messages/SSE, Vitest 3, MetaBot PTY and SDK execution paths.

## Global Constraints

- Do not install Tavily or any other web-search provider.
- Do not add a search API key, generated search MCP config, or search-provider prompt.
- Do not deny Claude Code native `WebSearch` or `WebFetch` in PTY, SDK, settings, or bot configuration.
- Do not rewrite, rename, remove, downgrade, or synthesize `web_search_20250305`.
- Skills may add domain workflows; MCP may connect explicit external systems; neither may shadow a native Claude Code tool.
- A top-level assistant record is recoverable only when `message.stop_reason === 'end_turn'` and it contains non-empty text.
- Partial text, thinking-only records, tool-use records, and subagent records must never turn an abnormal process exit into success.
- Keep current provider failures diagnostic; do not retry `POST /v1/messages` in MetaBot.
- Do not log prompts, search queries, response text, provider bodies, credentials, thinking, or signatures.
- Preserve unrelated worktree changes and `.tools/`; stage only task files.

---

### Task 1: Lock native web exposure and pass-through contracts

**Files:**
- Modify: `src/engines/claude/compatibility/profile.ts`
- Modify: `tests/claude-compatibility-profile.test.ts`
- Modify: `tests/claude-launch-compatibility.test.ts`
- Modify: `tests/claude-gateway-adapter.test.ts`

**Interfaces:**
- Consumes: `OPUS_PROFILE`, PTY/SDK launch captures, `startClaudeGatewayAdapter()`.
- Produces: profile declarations `nativeWebTools` and `nativeToolFailureMode`; negative launch assertions; byte-preserving server-tool contract.

- [ ] **Step 1: Write failing profile and launch tests**

```ts
expect(OPUS_PROFILE.nativeWebTools).toEqual(['WebSearch', 'WebFetch']);
expect(OPUS_PROFILE.nativeToolFailureMode).toBe('recoverable-turn');
expect(ptySpawn.args.join(' ')).not.toMatch(/disallowedTools.*Web(Search|Fetch)/);
expect(sdkOptions.disallowedTools ?? []).not.toContain('WebSearch');
expect(sdkOptions.disallowedTools ?? []).not.toContain('WebFetch');
expect(ptySpawn.args).not.toContain('--mcp-config');
expect(sdkOptions.mcpServers ?? {}).not.toHaveProperty('tavily');
```

- [ ] **Step 2: Write the failing adapter pass-through test**

Send a deliberately spaced JSON body containing:

```json
{ "model":"claude-opus-4-8", "tools":[{"type":"web_search_20250305","name":"web_search"}], "messages":[{"role":"user","content":"search"}] }
```

Assert the fake upstream receives the exact original `Buffer`, including
whitespace and the exact server-tool type. Assert the adapter performs zero
image promotions.

- [ ] **Step 3: Run RED**

```bash
npx vitest run tests/claude-compatibility-profile.test.ts \
  tests/claude-launch-compatibility.test.ts \
  tests/claude-gateway-adapter.test.ts
```

Expected: profile assertions fail before the fields exist; any launch denial
or request reserialization fails the corresponding contract.

- [ ] **Step 4: Implement the minimal profile fields**

```ts
export const OPUS_PROFILE = Object.freeze({
  // existing profile fields
  nativeWebTools: ['WebSearch', 'WebFetch'] as const,
  nativeToolFailureMode: 'recoverable-turn' as const,
});
```

Do not add runtime behavior for these declarative fields. Remove any
web-specific denied-tool or MCP injection found while wiring the Core plan.
The adapter's existing non-target branch must forward the original request
buffer rather than parsed/re-serialized JSON.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/claude-compatibility-profile.test.ts \
  tests/claude-launch-compatibility.test.ts \
  tests/claude-gateway-adapter.test.ts
git add src/engines/claude/compatibility/profile.ts \
  tests/claude-compatibility-profile.test.ts \
  tests/claude-launch-compatibility.test.ts \
  tests/claude-gateway-adapter.test.ts
git commit -m "test: preserve Claude native web tools"
```

Expected: all selected tests pass and `git diff --cached` contains no Tavily
dependency, key, config, or prompt.

### Task 2: Recover only completed assistant answers after PTY exit

**Files:**
- Create: `src/engines/claude/pty/turn-recovery.ts`
- Create: `tests/pty-turn-recovery.test.ts`
- Modify: `src/engines/claude/pty/pty-query.ts`
- Modify: `tests/stream-processor.test.ts`

**Interfaces:**
- Produces: `extractCompletedAssistantText(record): string | null` and `resolveUnexpectedExit(completedText): { isError: boolean; resultText: string }`.
- Consumes: raw Claude session JSONL records and `synthesizeResult()`.

- [ ] **Step 1: Write failing extraction tests**

```ts
expect(extractCompletedAssistantText({
  type: 'assistant', parentToolUseID: null,
  message: {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Live search is currently unavailable.' }],
  },
})).toBe('Live search is currently unavailable.');

expect(extractCompletedAssistantText({
  type: 'assistant', parentToolUseID: null,
  message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'partial' }] },
})).toBeNull();

expect(extractCompletedAssistantText({
  type: 'assistant', parentToolUseID: 'subagent-1',
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'nested' }] },
})).toBeNull();
```

Add cases for empty text, thinking-only content, multiple text blocks joined
with `\n`, and `parent_tool_use_id` snake-case input.

- [ ] **Step 2: Write failing exit-resolution tests**

```ts
expect(resolveUnexpectedExit('Provider search is unavailable.')).toEqual({
  isError: false,
  resultText: 'Provider search is unavailable.',
});
expect(resolveUnexpectedExit(null)).toEqual({
  isError: true,
  resultText: 'claude process exited before the turn completed',
});
```

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/pty-turn-recovery.test.ts`

Expected: FAIL because `turn-recovery.ts` does not exist.

- [ ] **Step 4: Implement the pure recovery boundary**

```ts
export function extractCompletedAssistantText(record: RawJsonlRecord): string | null {
  if (record.type !== 'assistant') return null;
  if (record.parentToolUseID != null || record.parent_tool_use_id != null) return null;
  const message = record.message as Record<string, unknown> | undefined;
  if (message?.stop_reason !== 'end_turn' || !Array.isArray(message.content)) return null;
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

export function resolveUnexpectedExit(completedText: string | null) {
  const text = completedText?.trim();
  return text
    ? { isError: false, resultText: text }
    : { isError: true, resultText: 'claude process exited before the turn completed' };
}
```

- [ ] **Step 5: Wire the tracker into `ptyQuery`**

Add `let completedTurnText: string | null = null`. Reset it immediately before
typing each new prompt. In `runScanner()`, update it only when
`extractCompletedAssistantText(rec)` returns non-null. In
`handleSessionExit()`, call `resolveUnexpectedExit(completedTurnText)` and pass
both returned fields to `synthesizeResult()`.

Never use `StreamProcessor.responseText`, PTY screen text, thinking, or a
`tool_use` record as recovery evidence.

- [ ] **Step 6: Prove the resulting card state**

Add a StreamProcessor test that processes the recovered `result/success` and
expects `status: 'complete'` with the explanation. Add the no-text
`result/error` case and expect the existing error message.

- [ ] **Step 7: Run GREEN and commit**

```bash
npx vitest run tests/pty-turn-recovery.test.ts tests/stream-processor.test.ts \
  tests/persistent-executor-abort.test.ts tests/persistent-executor-burst.test.ts
git add src/engines/claude/pty/turn-recovery.ts \
  src/engines/claude/pty/pty-query.ts \
  tests/pty-turn-recovery.test.ts tests/stream-processor.test.ts
git commit -m "fix: preserve completed Claude answer on PTY exit"
```

### Task 3: Classify native web capability without toggling it

**Files:**
- Modify: `scripts/probe-opus-gateway-capabilities.ts`
- Modify: `tests/opus-capability-probe.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: sanitized `native_web_search` and `native_web_fetch` evidence.
- Consumes: explicit Claude executable, model, gateway configuration, and current Core probe redaction helpers.

- [ ] **Step 1: Write failing classification tests**

```ts
expect(classifyNativeWebSearch({
  status: 400,
  errorType: 'aws_invoke_error',
  sanitizedMessage: "ValidationException: tool type 'web_search_20250305' is not supported for this model",
  completedRequests: 0,
})).toBe('upstream_unsupported');
expect(classifyNativeWebSearch({ status: 200, completedRequests: 1 })).toBe('available');
expect(classifyNativeWebSearch({ networkError: true, completedRequests: 0 })).toBe('transport_error');
```

Add separate WebFetch cases for `available`, `domain_verification_failed`,
`transport_error`, and `unexpected_error`.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/opus-capability-probe.test.ts`

Expected: FAIL because the native web classifiers/evidence do not exist.

- [ ] **Step 3: Implement sanitized classifications**

Evidence contains only:

```ts
type NativeWebEvidence = {
  status: 'available' | 'upstream_unsupported' |
    'domain_verification_failed' | 'transport_error' | 'unexpected_error';
  httpStatus?: number;
  providerErrorType?: string;
  completedRequests: number;
  latencyMs: number;
};
```

Do not store provider message bodies, queries, returned pages, citations,
request IDs, or authorization data. Probe results do not modify profile,
settings, bot config, or launch flags.

- [ ] **Step 4: Add explicit local CLI smoke commands**

`npm run probe:opus-native-web` invokes Claude Code 2.1.207 with explicit
`claude-opus-4-8`, `--tools WebSearch`, and `--allowedTools WebSearch`. A second
case invokes only WebFetch. The command exits zero when evidence is safely
classified, even when current status is `upstream_unsupported`; it exits
non-zero only for malformed/unsafe evidence or probe infrastructure failure.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/opus-capability-probe.test.ts
npm run build:bridge
git add scripts/probe-opus-gateway-capabilities.ts \
  tests/opus-capability-probe.test.ts package.json package-lock.json
git commit -m "test: classify Claude native web capability"
```

### Task 4: Document and execute the two-stage acceptance

**Files:**
- Modify: `docs/configuration/environment-variables.md`
- Modify: `docs/configuration/environment-variables.zh.md`
- Create: `docs/operations/opus-native-web-acceptance.md`

**Interfaces:**
- Produces: one owner-run acceptance procedure before and after the provider repair.
- Consumes: `npm run probe:opus-native-web` and MetaBot Marketing Bot smoke messages.

- [ ] **Step 1: Document the current expected state**

Record that ordinary Opus text succeeds, WebSearch currently classifies as
`upstream_unsupported`, and Claude's non-empty explanation must be sent as a
normal Bot reply. Explicitly state that no Tavily key or search MCP is needed.

- [ ] **Step 2: Document the provider-repair gate**

After the provider announces a repair, run the identical probe without code or
configuration changes. Require `native_web_search.status === 'available'`,
`completedRequests > 0`, and a Marketing Bot answer containing live citations.
Test WebFetch separately against `https://example.com/` and the original
failing URL.

- [ ] **Step 3: Verify documentation and repository constraints**

```bash
rg -n -i "TAVILY_API_KEY|tavily-mcp|mcp__tavily" \
  src tests package.json docs/configuration docs/operations
npx vitest run tests/pty-turn-recovery.test.ts \
  tests/opus-capability-probe.test.ts tests/claude-gateway-adapter.test.ts
npm run build:bridge
```

Expected: the `rg` command returns no matches in implementation/configuration;
all tests and the bridge build pass.

- [ ] **Step 4: Commit**

```bash
git add docs/configuration/environment-variables.md \
  docs/configuration/environment-variables.zh.md \
  docs/operations/opus-native-web-acceptance.md
git commit -m "docs: add native web acceptance gate"
```
