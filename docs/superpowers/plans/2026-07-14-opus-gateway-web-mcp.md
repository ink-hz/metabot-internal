# Opus Gateway Web MCP Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incompatible Claude Code `WebSearch`/`WebFetch` tools with pinned Tavily MCP search/extract while making HR web access impossible and making unavailable web state explicit to the model.

**Architecture:** Each Claude bot has a `required`, `optional`, or `disabled` policy. A private per-executor MCP config launches the pinned local Tavily package when allowed; PTY receives `--mcp-config`, SDK receives the equivalent `mcpServers` object, and both deny broken built-ins plus Tavily map/crawl. Prompt text truthfully distinguishes available, unavailable, and privacy-disabled web access.

**Tech Stack:** TypeScript 5.9, Claude Code 2.1.207, Claude Agent SDK 0.3.154+, `tavily-mcp@0.2.21`, Vitest 3, macOS Keychain/bootstrap, PM2.

## Global Constraints

- This plan starts only after Core Task 5 provides `deniedTools` and MCP launch seams.
- Use only `claude-opus-4-8`; never configure or invoke Fable or a fallback model.
- Always deny built-in `WebSearch` and `WebFetch` for the selected compatibility profile.
- Expose only Tavily search/extract; deny `mcp__tavily__tavily-map` and `mcp__tavily__tavily-crawl`.
- Pin `tavily-mcp` exactly to `0.2.21`; never use runtime `npx -y` or `latest`.
- Never place `TAVILY_API_KEY` in source control, `bots.json`, prompts, logs, or capability evidence.
- `hr-bot` is explicitly `disabled`; candidate/employee content must have no Tavily route.
- `marketing-bot` is `required` only after a Keychain key is present.
- `feishu-default`, `pc-bot`, `quality-bot`, and `fae-bot` are `optional` initially.
- Optional-without-MCP must tell Opus that live web access is unavailable and current facts must not be guessed.
- Preserve unrelated worktree changes; stage only task files.

---

### Task 1: Add per-bot web policy and truthful prompt states

**Files:**
- Create: `src/engines/claude/web-tools/policy.ts`
- Create: `tests/claude-web-tools-policy.test.ts`
- Modify: `src/config.ts`
- Modify: `src/engines/claude/executor-registry.ts`
- Modify: `src/engines/claude/persistent-executor.ts`
- Modify: `src/engines/claude/executor.ts`

**Interfaces:**
- Produces: `ClaudeWebToolsPolicy`, `resolveWebToolsState`, and `webToolsSystemPrompt`.
- Consumes: per-bot `webTools` JSON field, package/key availability, bot name.

- [ ] **Step 1: Write failing policy tests**

```ts
expect(() => resolveWebToolsState('required', { packageFound: false, key: undefined }))
  .toThrow(/required/);
expect(resolveWebToolsState('optional', { packageFound: false, key: undefined }))
  .toEqual({ state: 'unavailable', reason: 'package-and-key-missing' });
expect(resolveWebToolsState('disabled', { packageFound: true, key: 'secret' }))
  .toEqual({ state: 'disabled', reason: 'policy' });

expect(webToolsSystemPrompt('unavailable', 'fae-bot')).toContain(
  'Live web access is unavailable in this session',
);
expect(webToolsSystemPrompt('unavailable', 'fae-bot')).toContain(
  'qualify current or time-sensitive claims',
);
expect(webToolsSystemPrompt('disabled', 'hr-bot')).toContain(
  'Do not send candidate, employee, or HR-private content to external web services',
);
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/claude-web-tools-policy.test.ts`

Expected: FAIL because policy module does not exist.

- [ ] **Step 3: Implement exact policy types and prompt text**

```ts
export type ClaudeWebToolsPolicy = 'required' | 'optional' | 'disabled';
export type WebToolsState = 'available' | 'unavailable' | 'disabled';

export function resolveWebToolsState(
  policy: ClaudeWebToolsPolicy,
  availability: { packageFound: boolean; key?: string },
): { state: WebToolsState; reason: string } {
  if (policy === 'disabled') return { state: 'disabled', reason: 'policy' };
  if (availability.packageFound && availability.key) {
    return { state: 'available', reason: 'ready' };
  }
  if (policy === 'required') {
    throw new Error('Web MCP is required but the pinned Tavily package or key is missing');
  }
  return {
    state: 'unavailable',
    reason: availability.packageFound ? 'key-missing' : availability.key ? 'package-missing' : 'package-and-key-missing',
  };
}
```

`webToolsSystemPrompt()` returns one fixed paragraph per state. Available maps
search intent to `tavily-search` and public URL extraction to `tavily-extract`.
Unavailable explicitly says no live web access and requires qualification of
current claims. HR-disabled explicitly prohibits external transmission of
candidate, employee, compensation, performance, identity, or family content.

- [ ] **Step 4: Thread policy from config to executors**

Add `webTools?: ClaudeWebToolsPolicy` to JSON engine fields and
`claude.webTools: ClaudeWebToolsPolicy` to `BotConfigBase`. Default to
`optional` in generic config. Add `webToolsPolicy` to registry and persistent/
legacy executor options. Append the state-specific paragraph to the existing
Claude system prompt exactly once per executor.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/claude-web-tools-policy.test.ts \
  tests/persistent-executor-abort.test.ts tests/persistent-executor-burst.test.ts
npm run build:bridge
```

Expected: all exit `0`.

```bash
git add src/engines/claude/web-tools/policy.ts \
  tests/claude-web-tools-policy.test.ts src/config.ts \
  src/engines/claude/executor-registry.ts \
  src/engines/claude/persistent-executor.ts src/engines/claude/executor.ts
git commit -m "feat: add Claude web tool policies"
```

### Task 2: Generate a private pinned Tavily MCP configuration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/engines/claude/web-tools/tavily-config.ts`
- Create: `tests/tavily-mcp-config.test.ts`

**Interfaces:**
- Produces: `createTavilyMcpConfig(options): TavilyMcpHandle`.
- Handle exposes `configPath`, SDK `mcpServers`, `deniedTools`, and `dispose()`.

- [ ] **Step 1: Pin the official package**

Run: `npm install --save-exact tavily-mcp@0.2.21`

Expected: exact version in manifest and lockfile; no install command is needed
at bot startup.

- [ ] **Step 2: Write failing private-config tests**

```ts
const handle = createTavilyMcpConfig({
  apiKey: 'TAVILY_TEST_KEY',
  root: temporaryRoot(),
});
const config = JSON.parse(readFileSync(handle.configPath, 'utf8'));

expect(statSync(dirname(handle.configPath)).mode & 0o777).toBe(0o700);
expect(statSync(handle.configPath).mode & 0o777).toBe(0o600);
expect(config.mcpServers.tavily.command).toBe(process.execPath);
expect(config.mcpServers.tavily.args[0]).toMatch(/tavily-mcp\/build\/index\.js$/);
expect(config.mcpServers.tavily.env.TAVILY_API_KEY).toBe('TAVILY_TEST_KEY');
expect(config.mcpServers.tavily.env.ANTHROPIC_AUTH_TOKEN).toBe('');
expect(handle.deniedTools).toEqual([
  'WebSearch',
  'WebFetch',
  'mcp__tavily__tavily-map',
  'mcp__tavily__tavily-crawl',
]);
```

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/tavily-mcp-config.test.ts`

Expected: FAIL because config generator does not exist.

- [ ] **Step 4: Implement deterministic local binary resolution**

Resolve `tavily-mcp/package.json` with `createRequire(import.meta.url)`, then
join `build/index.js`. Generate:

```ts
const server = {
  command: process.execPath,
  args: [tavilyEntryPoint],
  env: {
    TAVILY_API_KEY: options.apiKey,
    DEFAULT_PARAMETERS: JSON.stringify({
      search_depth: 'basic',
      max_results: 8,
      include_images: false,
    }),
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    FEISHU_APP_SECRET: '',
    METABOT_API_SECRET: '',
    FLYWHEEL_API_SECRET: '',
    PGPASSWORD: '',
  },
};
```

Write `{ mcpServers: { tavily: server } }` in a mode-0700 temporary directory
with file mode 0600. Return the same server under SDK shape
`mcpServers: { tavily: server }`. `dispose()` removes only that private temp
directory.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx vitest run tests/tavily-mcp-config.test.ts`

Expected: all tests pass and no output contains `TAVILY_TEST_KEY`.

```bash
git add package.json package-lock.json \
  src/engines/claude/web-tools/tavily-config.ts \
  tests/tavily-mcp-config.test.ts
git commit -m "feat: generate pinned Tavily MCP config"
```

### Task 3: Deny broken tools and mount Tavily in PTY and SDK

**Files:**
- Create: `tests/claude-web-tools-launch.test.ts`
- Modify: `src/engines/claude/compatibility/runtime.ts`
- Modify: `src/engines/claude/executor.ts`
- Modify: `src/engines/claude/persistent-executor.ts`
- Modify: `src/engines/claude/pty/contract.ts`
- Modify: `src/engines/claude/pty/pty-query.ts`
- Modify: `src/engines/claude/pty/pty-session.ts`

**Interfaces:**
- Consumes: Core launch seams, per-bot policy, `TAVILY_API_KEY`, Tavily handle.
- Produces: equivalent PTY CLI and SDK query behavior; per-executor cleanup.

- [ ] **Step 1: Write failing launch parity tests**

```ts
expect(pty.args).toEqual(expect.arrayContaining([
  '--disallowedTools', 'WebSearch', 'WebFetch',
  'mcp__tavily__tavily-map', 'mcp__tavily__tavily-crawl',
  '--mcp-config', handle.configPath,
]));
expect(sdk.disallowedTools).toEqual(handle.deniedTools);
expect(sdk.mcpServers).toEqual(handle.mcpServers);
expect(sdk.model).toBe('claude-opus-4-8');
```

Add cases for required-missing (executor start rejects), optional-missing (no
MCP path/server but built-ins still denied), and disabled (no Tavily handle).

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/claude-web-tools-launch.test.ts`

Expected: FAIL because launch paths do not consume the policy/handle.

- [ ] **Step 3: Implement per-executor MCP lifecycle**

Resolve state before starting Claude. For available state create one Tavily
handle and pass `configPath` to PTY or `mcpServers` to SDK. In every state set:

```ts
const deniedTools = state === 'available'
  ? ['WebSearch', 'WebFetch', 'mcp__tavily__tavily-map', 'mcp__tavily__tavily-crawl']
  : ['WebSearch', 'WebFetch'];
```

Dispose the handle after the Claude process/query is drained, including crash,
restart, registry eviction, `/reset`, and normal shutdown. Recreate a fresh
private config on executor restart.

- [ ] **Step 4: Verify no broken built-in can leak through**

Add assertions to both PTY argv and SDK options for optional-missing and
disabled states. Also assert optional-missing prompt contains the unavailable
paragraph and HR-disabled prompt contains the privacy paragraph.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/claude-web-tools-launch.test.ts \
  tests/tavily-mcp-config.test.ts tests/claude-web-tools-policy.test.ts \
  tests/executor-registry-crash.test.ts tests/executor-registry-race.test.ts
npm run build:bridge
```

Expected: all exit `0`.

```bash
git add tests/claude-web-tools-launch.test.ts \
  src/engines/claude/compatibility/runtime.ts \
  src/engines/claude/executor.ts src/engines/claude/persistent-executor.ts \
  src/engines/claude/pty/contract.ts src/engines/claude/pty/pty-query.ts \
  src/engines/claude/pty/pty-session.ts
git commit -m "feat: replace Claude web tools with Tavily MCP"
```

### Task 4: Add mocked MCP reliability and privacy acceptance

**Files:**
- Create: `scripts/smoke-tavily-mcp.ts`
- Create: `tests/tavily-mcp-smoke.test.ts`
- Modify: `package.json`
- Modify: `docs/configuration/environment-variables.md`
- Modify: `docs/configuration/environment-variables.zh.md`

**Interfaces:**
- Produces: `npm run smoke:tavily-mcp` with mocked and opt-in live modes.
- Consumes: generated config, explicit Opus model, optional `TAVILY_API_KEY`.

- [ ] **Step 1: Write a failing mocked MCP smoke test**

Start the pinned Tavily stdio process with a non-secret test key and perform
only MCP `initialize` plus `tools/list`; listing tools does not call Tavily's
search API. Require discovery to show search/extract and verify launch policy
denies map/crawl. Separately use a deterministic fake stdio MCP fixture to
exercise a tool call without external traffic. Capture the fake process
environment and assert unrelated secret markers are empty or absent. Assert
disabled HR policy never starts either MCP process.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/tavily-mcp-smoke.test.ts`

Expected: FAIL because smoke tooling does not exist.

- [ ] **Step 3: Implement mocked and live modes**

Default mode performs `tools/list` against the real pinned package and a tool
call against the local fake stdio fixture; it incurs no external search
request. Live mode runs only when both `TAVILY_LIVE_TEST=1` and
`TAVILY_API_KEY` are present. It asks search for `Orbbec official website` and extract for
`https://www.orbbec.com/`, asserting non-empty source URLs/text without logging
full results or the key.

Add:

```json
{
  "smoke:tavily-mcp": "tsx scripts/smoke-tavily-mcp.ts"
}
```

- [ ] **Step 4: Document policies and unavailable behavior**

Document `webTools: required|optional|disabled`, `TAVILY_API_KEY`, the exact
tool deny list, the Marketing required/HR disabled runtime policy, and the
unavailable prompt behavior. State that Tavily is external and live acceptance
may incur usage charges.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/tavily-mcp-smoke.test.ts \
  tests/claude-web-tools-launch.test.ts
npm run smoke:tavily-mcp
```

Expected: mocked tests pass without a key and no external call is made.

```bash
git add scripts/smoke-tavily-mcp.ts tests/tavily-mcp-smoke.test.ts \
  package.json docs/configuration/environment-variables.md \
  docs/configuration/environment-variables.zh.md
git commit -m "test: verify Tavily MCP web tools"
```

### Task 5: Configure Keychain policies and deploy all six bots

**Files:**
- Verify/modify privately: `/Users/agentops/AgentRuntime/metabot/bots.json`
- Verify privately: `agentops` Keychain item `metabot-tavily-api-key`
- Verify: `/Users/agentops/AgentRuntime/metabot`

**Interfaces:**
- Consumes: owner-supplied Tavily key, completed Core deployment, Web MCP tests.
- Produces: Marketing live search/extract, HR no-web boundary, explicit optional state for four other bots.

- [ ] **Step 1: Back up private runtime configuration**

Back up `bots.json`, bootstrap environment, PM2 description, and current
runtime build without printing app secrets or API keys.

- [ ] **Step 2: Install the owner-supplied key once**

After the owner exports `TAVILY_API_KEY` in a private shell, store/update:

```bash
sudo -n -u agentops security add-generic-password -U \
  -a agentops -s metabot-tavily-api-key -w "$TAVILY_API_KEY"
```

Update the existing bootstrap to read the value with
`security find-generic-password -a agentops -s metabot-tavily-api-key -w` and
export it only into the MetaBot process. Do not print it or persist it in PM2
JSON dumps.

- [ ] **Step 3: Set explicit per-bot policies**

Set these private `bots.json` values:

```text
feishu-default: optional
hr-bot: disabled
marketing-bot: required
pc-bot: optional
quality-bot: optional
fae-bot: optional
```

All six models remain exactly `claude-opus-4-8`.

- [ ] **Step 4: Run live Tavily gate before restart**

Run as `agentops` with Keychain-loaded env:

```bash
TAVILY_LIVE_TEST=1 npm run smoke:tavily-mcp
```

Expected: one search and one extract pass; logs show tool/status/latency only.

- [ ] **Step 5: Restart and verify process policy**

Deploy verified source/build and restart PM2 through the existing passwordless
path. Inspect live Claude argv/options:

- every bot denies `WebSearch` and `WebFetch`;
- Marketing has Tavily MCP and denies map/crawl;
- HR has no Tavily config and contains the HR privacy prompt;
- optional bots either have Tavily available or contain the explicit
  unavailable prompt;
- every bot remains on `claude-opus-4-8` with no Fable/fallback argument.

- [ ] **Step 6: User-visible acceptance**

Ask Marketing for one current public-company fact requiring search and one
official URL extraction; require cited live results. Ask HR a current-news
question; require it to state live web access is disabled/unavailable rather
than invoke Tavily or guess. Confirm no HR message appears in Tavily/mock logs.

- [ ] **Step 7: Roll back Web MCP independently on failure**

Restore private configuration/runtime, keep built-in web tools denied, set
Marketing to `optional`, and restart. Core text/image/PDF operation must remain
available on Opus while Web MCP is unavailable.
