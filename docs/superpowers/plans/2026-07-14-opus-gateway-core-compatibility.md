# Opus Gateway Core Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all MetaBot Claude traffic through a version-locked loopback adapter that restores image `Read` semantics for `claude-opus-4-8` without regressing normal requests, cache behavior, sessions, or PDFs.

**Architecture:** One conservative profile owns an authenticated in-process HTTP adapter. MetaBot injects its loopback URL into both process env and generated Claude settings because a real two-listener probe proved settings win. The adapter returns original bytes for non-target requests and uses lossless JSON only for the exact broken nested-image shape.

**Tech Stack:** TypeScript 5.9, Node.js HTTP/streams, `lossless-json@4.3.0`, Claude Code `2.1.207`, Vitest 3, PM2 on macOS.

## Global Constraints

- Use only `claude-opus-4-8`; never invoke, probe, configure, or fall back to Fable.
- Require Claude Code exactly `2.1.207` for profile `nexcor-opus-4-8-claude-code-2.1.207`.
- Keep context at `200000`; do not enable the unverified 1M route.
- Override `ANTHROPIC_BASE_URL` in child env and generated settings; settings wins last.
- Bind only to `127.0.0.1` on an OS-assigned port and validate the existing Anthropic token.
- Do not log prompts, bodies, filenames, response text, thinking, signatures, attachment bytes, or credentials.
- Do not retry `POST /v1/messages` inside the adapter.
- Forward non-target bytes unchanged and ambiguous image shapes unchanged.
- Preserve PDFs, unknown fields, lossless numbers, cache controls, SSE bytes/order, sessions, and hooks.
- Keep the temporary image fallback until the real PTY image/cache gate passes.
- Preserve unrelated worktree changes and `.tools/`; stage only task files.

---

### Task 1: Gate and enforce base-URL precedence

**Files:**
- Create: `scripts/probe-claude-settings-env-precedence.ts`
- Modify: `src/engines/claude/pty/hook-bridge.ts`
- Modify: `tests/pty-hook-bridge.test.ts`

**Interfaces:**
- Consumes: `createHookBridge(options)` and the configured Claude executable.
- Produces: `HookBridgeOptions.settingsEnv?: Record<string, string>`; compatibility env is merged after private user env.

- [ ] **Step 1: Add the two-listener probe**

Implement two local HTTP listeners named `process_env` and `settings_json`.
Both return 200 for `HEAD /` and an Anthropic 401 envelope for other paths.
Spawn:

```ts
spawn(claude, [
  '-p', 'Reply with OK only.',
  '--model', 'claude-opus-4-8',
  '--output-format', 'json',
  '--settings', JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: settingsUrl,
    ANTHROPIC_AUTH_TOKEN: 'probe-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  } }),
], {
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: processEnvUrl,
    ANTHROPIC_AUTH_TOKEN: 'probe-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
  stdio: 'ignore',
});
```

Wait up to eight seconds for `/v1/messages`, kill the child, print only request
method/path counts, and exit non-zero unless process-env requests are zero and
settings receives `POST /v1/messages?beta=true`.

- [ ] **Step 2: Run the pre-transform gate**

Run:

```bash
./node_modules/.bin/esbuild scripts/probe-claude-settings-env-precedence.ts \
  --bundle --platform=node --format=esm \
  --outfile=/tmp/probe-claude-settings-env-precedence.mjs
chmod 0644 /tmp/probe-claude-settings-env-precedence.mjs
sudo -n -u agentops env \
  CLAUDE_EXECUTABLE_PATH=/Users/agentops/.npm-global/bin/claude \
  node /tmp/probe-claude-settings-env-precedence.mjs
rm -f /tmp/probe-claude-settings-env-precedence.mjs
```

Expected: exit `0`, `winner=settings_json`, no request at the process-env
listener, and one settings `POST /v1/messages?beta=true`. Stop this plan if the
result differs.

- [ ] **Step 3: Write the failing merge test**

```ts
const bridge = createHookBridge({
  sourceSettingsPath,
  settingsEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123' },
});
const generated = JSON.parse(readFileSync(await bridge.writeSettings(), 'utf8'));
expect(generated.env).toEqual({
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
  ANTHROPIC_AUTH_TOKEN: 'keep-user-token',
});
```

- [ ] **Step 4: Run RED**

Run: `npx vitest run tests/pty-hook-bridge.test.ts`

Expected: FAIL because `settingsEnv` does not exist.

- [ ] **Step 5: Implement last-write-wins env**

Add `settingsEnv?: Record<string, string>` to `HookBridgeOptions` and construct:

```ts
const sourceEnv = userSettings.env;
const env = {
  ...(sourceEnv && typeof sourceEnv === 'object' && !Array.isArray(sourceEnv)
    ? sourceEnv as Record<string, unknown>
    : {}),
  ...(options?.settingsEnv ?? {}),
};
const settings = {
  ...userSettings,
  ...(Object.keys(env).length ? { env } : {}),
  hooks,
};
```

- [ ] **Step 6: Run GREEN and commit**

Run: `npx vitest run tests/pty-hook-bridge.test.ts`

Expected: all hook-bridge tests pass.

```bash
git add scripts/probe-claude-settings-env-precedence.ts \
  src/engines/claude/pty/hook-bridge.ts tests/pty-hook-bridge.test.ts
git commit -m "test: gate Claude settings URL precedence"
```

### Task 2: Add the profile, version assertion, and model guard

**Files:**
- Create: `src/engines/claude/compatibility/profile.ts`
- Create: `src/engines/claude/compatibility/version.ts`
- Create: `tests/claude-compatibility-profile.test.ts`
- Modify: `src/config.ts`
- Modify: `src/bridge/command-handler.ts`
- Modify: `tests/command-handler-model-status.test.ts`

**Interfaces:**
- Produces: `loadClaudeCompatibilityProfile`, `assertAllowedClaudeModel`, and `assertCompatibleClaudeVersion`.
- Consumes: `METABOT_CLAUDE_COMPAT_PROFILE`, bot/session model, resolved CLI path.

- [ ] **Step 1: Write failing profile tests**

```ts
const profile = loadClaudeCompatibilityProfile({
  METABOT_CLAUDE_COMPAT_PROFILE: 'nexcor-opus-4-8-claude-code-2.1.207',
});
expect(profile).toMatchObject({
  claudeCodeVersion: '2.1.207',
  allowedModels: ['claude-opus-4-8'],
  contextWindow: 200_000,
  promoteToolResultImages: true,
});
expect(() => assertAllowedClaudeModel(profile!, 'claude-fable-5')).toThrow();
expect(() => assertAllowedClaudeModel(profile!, 'claude-opus-4-8[1m]')).toThrow();
expect(() => assertCompatibleClaudeVersion(
  profile!, '/opt/claude', () => '2.1.208 (Claude Code)',
)).toThrow(/expected 2\.1\.207/);
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/claude-compatibility-profile.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement immutable profile and version check**

```ts
export const OPUS_PROFILE = Object.freeze({
  id: 'nexcor-opus-4-8-claude-code-2.1.207' as const,
  claudeCodeVersion: '2.1.207' as const,
  allowedModels: ['claude-opus-4-8'] as const,
  contextWindow: 200_000 as const,
  promoteToolResultImages: true as const,
});

export function assertAllowedClaudeModel(profile: typeof OPUS_PROFILE, model?: string): void {
  if (model !== 'claude-opus-4-8') {
    throw new Error(`Claude model ${model ?? '(unset)'} is not allowed by ${profile.id}`);
  }
}
```

`assertCompatibleClaudeVersion()` runs `[executable, '--version']`, extracts
the first semver, and throws unless it is exactly `2.1.207`. Keep the runner
injectable for tests.

- [ ] **Step 4: Guard config and `/model`**

When a profile is selected, validate every Claude bot during config load.
Filter the Claude model picker to the allowlist and reject typed disallowed
models before mutating session state. Tests must prove the picker contains
Opus, omits `fable`, and `/model claude-fable-5` leaves the session unchanged.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/claude-compatibility-profile.test.ts \
  tests/command-handler-model-status.test.ts
```

Expected: all pass; unprofiled generic configurations remain unchanged.

```bash
git add src/engines/claude/compatibility/profile.ts \
  src/engines/claude/compatibility/version.ts \
  tests/claude-compatibility-profile.test.ts src/config.ts \
  src/bridge/command-handler.ts tests/command-handler-model-status.test.ts
git commit -m "feat: lock Opus compatibility profile"
```

### Task 3: Implement lossless and idempotent image promotion

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/engines/claude/compatibility/image-promotion.ts`
- Create: `tests/claude-image-promotion.test.ts`

**Interfaces:**
- Produces: `promoteToolResultImages(raw: Buffer): PromotionResult`.
- `PromotionResult`: pass-through with the original buffer, or transformed buffer plus promoted count.

- [ ] **Step 1: Pin lossless JSON**

Run: `npm install --save-exact lossless-json@4.3.0`

Expected: exact version in manifest and lockfile.

- [ ] **Step 2: Write failing tests**

Test exact nested image promotion, immediate sibling placement, PDF unchanged,
unsupported image unchanged, malformed JSON error, raw non-target byte equality,
large-integer preservation, `cache_control` preservation, and three historical
user messages with hashes `[demo1, demo2, demo1]`.

```ts
const raw = Buffer.from('{ "unknown":900719925474099312345, "messages":[] }');
const result = promoteToolResultImages(raw);
expect(result.kind).toBe('passthrough');
expect(result.body.equals(raw)).toBe(true);

const twice = promoteToolResultImages(promoteToolResultImages(historyBody).body);
expect(twice.kind).toBe('passthrough');
expect(imageHashesByUserMessage(twice.body)).toEqual([[demo1], [demo2], [demo1]]);
```

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/claude-image-promotion.test.ts`

Expected: FAIL because the transform does not exist.

- [ ] **Step 4: Implement the exact-shape transform**

Use `lossless-json` only after valid parsing identifies an exact nested image.
Supported media types are JPEG, PNG, GIF, and WebP. Deduplicate within each
user message with:

```ts
const imageKey = (block: ImageBlock) =>
  `${block.source.media_type}:${createHash('sha256')
    .update(block.source.data).digest('hex')}`;
```

For each matching `tool_result`, remove supported nested image blocks, keep all
other nested content, insert the fixed explanatory text if empty, then insert
each unique image immediately after that tool result. Preserve the whole image
object, including `cache_control`. Return the original `Buffer` if no exact
promotion occurs. Throw `InvalidAnthropicRequestError` only for malformed JSON;
ambiguous/unsupported structures pass through.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx vitest run tests/claude-image-promotion.test.ts`

Expected: all tests pass and second transformation is pass-through.

```bash
git add package.json package-lock.json \
  src/engines/claude/compatibility/image-promotion.ts \
  tests/claude-image-promotion.test.ts
git commit -m "feat: promote nested Claude image results"
```

### Task 4: Build the authenticated loopback adapter and retry contracts

**Files:**
- Create: `src/engines/claude/compatibility/anthropic-errors.ts`
- Create: `src/engines/claude/compatibility/adapter.ts`
- Create: `tests/claude-gateway-adapter.test.ts`
- Create: `scripts/probe-claude-http-retry.ts`

**Interfaces:**
- Produces: `startClaudeGatewayAdapter(options): Promise<ClaudeGatewayAdapter>`.
- Adapter exposes `baseUrl` and `close()`.

- [ ] **Step 1: Write failing adapter tests**

Use a local fake upstream. Assert non-message and non-target request bytes are
identical, transformed content types are `['tool_result', 'image']`, PDF stays
nested, SSE chunks/order are identical, and logs omit token/image/prompt markers.
Assert malformed or >64 MiB message bodies return HTTP 400
`invalid_request_error`; upstream connect failure returns HTTP 502 `api_error`;
the adapter sends each POST upstream at most once.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/claude-gateway-adapter.test.ts`

Expected: FAIL because adapter modules do not exist.

- [ ] **Step 3: Implement envelopes and adapter**

```ts
export const invalidRequest = (message: string) => ({
  status: 400,
  body: { type: 'error', error: { type: 'invalid_request_error', message } },
});
export const upstreamUnavailable = () => ({
  status: 502,
  body: { type: 'error', error: {
    type: 'api_error',
    message: 'The configured upstream gateway is temporarily unavailable.',
  } },
});
```

Bind `127.0.0.1:0`, compare `Authorization`/`x-api-key` in constant time,
remove hop-by-hop headers, buffer only `/v1/messages` including query strings,
and stream every upstream response without parsing. Update content-length only
for transformed bodies. Log method, path, status, duration, bytes, promoted
count, and error category only.

- [ ] **Step 4: Prove Claude Code retry behavior against fake responses**

`probe-claude-http-retry.ts` starts two fake endpoints and uses explicit Opus.
One returns two 502 `api_error` envelopes then a minimal valid message; one
always returns 400 `invalid_request_error`. It prints request counts only.

Run:

```bash
./node_modules/.bin/esbuild scripts/probe-claude-http-retry.ts \
  --bundle --platform=node --format=esm --outfile=/tmp/probe-claude-http-retry.mjs
chmod 0644 /tmp/probe-claude-http-retry.mjs
sudo -n -u agentops env CLAUDE_EXECUTABLE_PATH=/Users/agentops/.npm-global/bin/claude \
  node /tmp/probe-claude-http-retry.mjs
rm -f /tmp/probe-claude-http-retry.mjs
```

Expected: 502 count is greater than one; 400 count is exactly one; no real
gateway is contacted. Stop and revise the envelope if this differs.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/claude-image-promotion.test.ts \
  tests/claude-gateway-adapter.test.ts
```

Expected: all pass.

```bash
git add src/engines/claude/compatibility/anthropic-errors.ts \
  src/engines/claude/compatibility/adapter.ts \
  tests/claude-gateway-adapter.test.ts scripts/probe-claude-http-retry.ts
git commit -m "feat: add loopback Anthropic adapter"
```

### Task 5: Wire both env layers through PTY and SDK

**Files:**
- Create: `src/engines/claude/compatibility/runtime.ts`
- Create: `tests/claude-launch-compatibility.test.ts`
- Modify: `src/index.ts`
- Modify: `src/bridge/message-bridge.ts`
- Modify: `src/engines/claude/executor-registry.ts`
- Modify: `src/engines/claude/executor.ts`
- Modify: `src/engines/claude/persistent-executor.ts`
- Modify: `src/engines/claude/pty/contract.ts`
- Modify: `src/engines/claude/pty/pty-query.ts`
- Modify: `src/engines/claude/pty/pty-session.ts`

**Interfaces:**
- Produces: `ClaudeCompatibilityRuntime` with profile, child/settings env, future denied-tools/MCP seams, and `close()`.
- Consumes: upstream URL/token, loaded bots, resolved CLI path.

- [ ] **Step 1: Write failing launch tests**

```ts
expect(ptySpawn.env.ANTHROPIC_BASE_URL).toBe(adapter.baseUrl);
expect(generatedSettings.env.ANTHROPIC_BASE_URL).toBe(adapter.baseUrl);
expect(sdkOptions.env.ANTHROPIC_BASE_URL).toBe(adapter.baseUrl);
expect(sdkOptions.settings.env.ANTHROPIC_BASE_URL).toBe(adapter.baseUrl);
expect(ptySpawn.args).toContain('claude-opus-4-8');
expect(ptySpawn.args).not.toContain('--fallback-model');
```

Also prove version mismatch prevents adapter and bot startup.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/claude-launch-compatibility.test.ts`

Expected: FAIL because runtime plumbing does not exist.

- [ ] **Step 3: Implement runtime ownership**

```ts
export interface ClaudeCompatibilityRuntime {
  profile: ClaudeCompatibilityProfile;
  childEnv: NodeJS.ProcessEnv;
  settingsEnv: Record<string, string>;
  deniedTools: string[];
  mcpConfigPath?: string;
  close(): Promise<void>;
}
```

Start it in `main()` after config/filtering but before any Feishu/API client.
Capture upstream URL first, validate all bot models and CLI version, start the
adapter, and return loopback overrides. Throw before bots start on any failure.
Close after executor registries drain.

- [ ] **Step 4: Thread runtime through all Claude owners**

Pass runtime to `MessageBridge`, registry, persistent executor, and legacy
executor. Extend PTY options with `env`, `settingsEnv`, `deniedTools`, and
`mcpConfigPath`. PTY calls
`createHookBridge({ settingsEnv: options.settingsEnv })`; SDK sets both
`env: runtime.childEnv` and
`settings: { teammateMode: 'in-process', env: runtime.settingsEnv }`.

Add generic PTY CLI seams:

```ts
if (opts.deniedTools?.length) args.push('--disallowedTools', ...opts.deniedTools);
if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
```

Core leaves both empty; the Web plan supplies them.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/claude-launch-compatibility.test.ts \
  tests/pty-hook-bridge.test.ts tests/persistent-executor-abort.test.ts \
  tests/persistent-executor-burst.test.ts tests/message-bridge.test.ts
npm run build:bridge
```

Expected: all exit `0`.

```bash
git add src/index.ts src/bridge/message-bridge.ts \
  src/engines/claude/compatibility/runtime.ts \
  src/engines/claude/executor-registry.ts src/engines/claude/executor.ts \
  src/engines/claude/persistent-executor.ts \
  src/engines/claude/pty/contract.ts src/engines/claude/pty/pty-query.ts \
  src/engines/claude/pty/pty-session.ts tests/claude-launch-compatibility.test.ts
git commit -m "feat: route Claude through compatibility adapter"
```

### Task 6: Add sanitized capability and persistent cache probes

**Files:**
- Create: `scripts/probe-opus-gateway-capabilities.ts`
- Create: `scripts/smoke-opus-image-session.ts`
- Create: `tests/opus-capability-probe.test.ts`
- Modify: `package.json`
- Modify: `docs/configuration/environment-variables.md`
- Modify: `docs/configuration/environment-variables.zh.md`

**Interfaces:**
- Produces: mode-0600 evidence at `~/.metabot/capabilities/nexcor-opus-4-8-claude-code-2.1.207.json`.
- Consumes: `resources/demo-1.png`, `resources/demo-2.png`, generated PDF code `ORBBEC-7429`.

- [ ] **Step 1: Write failing redaction/evidence tests**

Assert evidence contains profile/model/versions/status/latency/block types/token
counters/error category/pass-fail, but omits token, prompt, base64, thinking,
signature, and response-text markers.

- [ ] **Step 2: Implement capability probe**

Probe metadata, text stream, ordinary tool use, direct image, nested image
before/after promotion, direct/nested PDF, cache usage, and expected built-in
web-search rejection. Write evidence atomically with mode `0600`. Add npm
scripts `probe:opus-gateway` and `smoke:opus-image-session`.

- [ ] **Step 3: Implement three-turn real PTY smoke**

Use one persistent session: `demo-1.png -> Metabot`,
`demo-2.png -> 17:17`, `demo-1.png -> Metabot`. Assert no content-block error,
`cache_read_input_tokens > 0` by turn two or three, and one ordered image hash
per historical user message: `[demo1, demo2, demo1]`.

- [ ] **Step 4: Verify and document**

```bash
npx vitest run tests/opus-capability-probe.test.ts \
  tests/claude-image-promotion.test.ts tests/claude-gateway-adapter.test.ts
```

Expected: all pass without real credentials. Document exactly:

```dotenv
METABOT_CLAUDE_COMPAT_PROFILE=nexcor-opus-4-8-claude-code-2.1.207
CLAUDE_MODEL=claude-opus-4-8
CLAUDE_CODE_DISABLE_1M_CONTEXT=1
CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000
```

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-opus-gateway-capabilities.ts \
  scripts/smoke-opus-image-session.ts tests/opus-capability-probe.test.ts \
  package.json docs/configuration/environment-variables.md \
  docs/configuration/environment-variables.zh.md
git commit -m "test: verify Opus gateway compatibility"
```

### Task 7: Deploy with fallback, pass the live gate, then remove fallback

**Files:**
- Modify: `src/bridge/message-bridge.ts`
- Modify: `tests/message-bridge.test.ts`
- Verify: `/Users/agentops/AgentRuntime/metabot`
- Verify: `/Users/agentops/.claude/settings.json`

**Interfaces:**
- Consumes: complete Core tests, real gateway probe, three-turn image/cache smoke.
- Produces: six live Opus bots with no image stripping and no Fable path.

- [ ] **Step 1: Run local pre-deployment verification**

```bash
npm run test:bridge
npm run build:bridge
npm run lint
```

Expected: all exit `0` while the temporary image fallback is still present.

- [ ] **Step 2: Back up and deploy the candidate with fallback intact**

Back up runtime source/build, PM2 description, and private Claude settings.
Deploy the verified Core candidate and probe scripts to
`/Users/agentops/AgentRuntime/metabot`, but do not remove the temporary image
fallback yet. Pin Claude Code `2.1.207`, set private default model to
`claude-opus-4-8`, remove the Fable-specific default env entry without printing
tokens, and restart through the existing passwordless path.

- [ ] **Step 3: Run live gateway and persistent cache gates**

Run from the runtime as `agentops`:

```bash
METABOT_CLAUDE_COMPAT_PROFILE=nexcor-opus-4-8-claude-code-2.1.207 \
  CLAUDE_MODEL=claude-opus-4-8 npm run probe:opus-gateway
npm run smoke:opus-image-session
```

Expected: image/PDF markers pass; evidence is mode `0600`; ordered answers are
`Metabot`, `17:17`, `Metabot`; cache read becomes non-zero; no duplicates and
no `Content block not found`.

- [ ] **Step 4: Remove only temporary fallback**

Delete `IMAGE_RELIABILITY_NOTICE`, `IMAGE_UNAVAILABLE_PROMPT_NOTE`,
`applyImageReliabilityFallback()`, its call, and its three temporary tests.
Keep ordinary image download and `Read` prompting unchanged.

- [ ] **Step 5: Re-run locally and commit**

```bash
npm run test:bridge
npm run build:bridge
npm run lint
git add src/bridge/message-bridge.ts tests/message-bridge.test.ts
git commit -m "fix: restore Opus image attachments"
```

Expected: every command exits `0`.

- [ ] **Step 6: Deploy the final build and repeat image/cache smoke**

Deploy the final verified build, restart PM2, then repeat
`npm run smoke:opus-image-session` from the runtime. The final build is accepted
only if it produces the same markers and cache-read assertion without the
fallback code.

- [ ] **Step 7: Run six-bot acceptance and secret scan**

Smoke `feishu-default`, `hr-bot`, `marketing-bot`, `pc-bot`, `quality-bot`, and
`fae-bot`. Every Claude command line must contain
`--model claude-opus-4-8`; none may contain `fable` or `--fallback-model`.
Known token/base64/thinking/signature markers must not occur in logs or
flywheel evidence.

- [ ] **Step 8: Roll back on any live failure**

Restore the backups, restart PM2, and retain/reapply image stripping. Rollback
must still use Opus and must never select Fable.
