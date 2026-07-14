# Opus Gateway Compatibility Layer Design

## Status

- Date: 2026-07-14
- Scope: MetaBot Claude engine, the `agentops` runtime, and all six Feishu bots
- Selected model: `claude-opus-4-8`
- Selected approach: local request adapter for the exact broken image shape,
  while preserving Claude Code's native tools as the primary capability path
- Extension policy: Skills and MCP servers may add domain workflows or connect
  external systems, but must not silently replace a Claude Code native tool
- Web replacement policy: no Tavily, external search API, or search MCP is
  introduced by this design
- Explicitly prohibited: any request, fallback, probe, or model-selection path that can invoke Fable

### 2026-07-14 native-capability decision

The owner selected the following implementation rule after reproducing the
failure directly in Claude Code:

1. Claude Code native capabilities are the foundation and must be made to work
   through the configured gateway rather than replaced when compatibility is
   missing.
2. Skills remain valid for domain knowledge and repeatable workflows.
3. MCP remains valid for explicit connections to systems Claude Code does not
   natively expose.
4. Skills and MCP must not shadow a native capability merely to hide a gateway
   defect.
5. While the provider repair is pending, a recoverable native tool failure
   must produce Claude Code's truthful final explanation instead of a red Bot
   process error.

## Problem

The current gateway advertises `claude-opus-4-8` as supporting reasoning,
tools, files, vision, and a 1M context window through Anthropic and OpenAI
endpoints. Those declarations are not sufficient for runtime routing. The
gateway metadata is internally inconsistent (`owned_by: aws`, a Venice
description, and Bedrock errors), and protocol probes show that several
individual Anthropic content/tool shapes behave differently.

The user-visible failure is not a weak-model problem. Normal Opus turns work,
but specific Claude Code tool paths either lose content or terminate the turn:

- `Read` returns an image inside a nested `tool_result`; the gateway accepts
  the request but loses the image semantics, and the real Claude Code path can
  end with `API Error: Content block not found`.
- built-in `WebSearch` reaches an upstream that rejects
  `web_search_20250305` for this model.
- built-in `WebFetch` depends on Claude Code's external domain-safety
  verification and fails even when the runtime can reach the target URL.

A local Claude Code 2.1.207 reproduction on 2026-07-14 proved the web-search
failure boundary. A plain `claude-opus-4-8` turn succeeded. The same CLI with
only `WebSearch` exposed produced an upstream `aws_invoke_error`: Bedrock
rejected server tool type `web_search_20250305` with HTTP 400. Claude Code then
completed the turn normally and explained that live search was unavailable;
the final process result was successful while `web_search_requests` remained
zero. This means the model and Claude Code process work, the server tool did
not run, and MetaBot must preserve Claude Code's recoverable final answer
rather than convert it into a red process error.

MetaBot currently contains an uncommitted emergency fallback in
`src/bridge/message-bridge.ts` that strips images before model execution. It
prevents a crash but removes a capability that the selected Opus route can
provide. The permanent solution must restore images without downgrading the
model or weakening the Claude Code agent environment.

## Verified baseline

The following facts were observed against the production gateway and the
`agentops` Claude Code runtime. Runtime probes are authoritative; gateway tags
are advisory only.

| Capability | Observed result | Runtime policy |
| --- | --- | --- |
| Text messages and streaming SSE | Pass | Native path |
| Extended thinking in Claude Code sessions | Pass | Native path |
| Client tools such as `Bash`, `Read`, and `AskUserQuestion` | Pass | Native path |
| Prompt caching | Pass | Native path |
| Persistent sessions and resume | Pass | Native path |
| Image as a top-level user content block | Pass; real screenshot read as `Metabot` | Native path |
| Image nested inside `tool_result.content` | Fail; image semantics lost and real CLI can report `Content block not found` | Request rewrite |
| Image promoted beside its `tool_result` in the same user message | Pass; real screenshot read as `Metabot` | Target wire format |
| PDF as top-level user content | Pass; verification code read correctly | Native path |
| PDF nested inside `tool_result.content` | Pass; verification code read correctly | Native path; do not rewrite |
| Built-in `WebSearch` | Current gateway route fails; Bedrock rejects `web_search_20250305` | Keep native tool exposed; preserve Claude Code's recoverable final answer; re-probe after gateway fix |
| Built-in `WebFetch` | Current domain-safety verification can fail | Keep native tool exposed; preserve its native result/error contract; diagnose separately from WebSearch |
| 1M context | Declared by gateway but not proved by the current Claude Code route | Treat as 200K |
| Claude Code MCP launch/config flags | Present in Claude Code 2.1.207 | Supported integration seam |
| `ANTHROPIC_BASE_URL` in process env versus `--settings` env | `--settings` wins for both `HEAD /` and `POST /v1/messages?beta=true` | Override both layers |

The validated runtime versions are:

- Claude Code: `2.1.207`
- Model: `claude-opus-4-8`
- Anthropic request header: `anthropic-version: 2023-06-01`
- Gateway build: `feat-request-debug-log-515a15a`

## Goals

1. Keep all six bots on `claude-opus-4-8` and prevent accidental Fable use.
2. Preserve Claude Code sessions, project instructions, tools, prompt caching,
   extended thinking, and the PTY backend.
3. Restore image analysis through the existing `Read` workflow.
4. Preserve Claude Code's native `WebSearch` and `WebFetch` path without
   substituting an external search provider.
5. Convert unsupported-capability failures into controlled tool or turn errors,
   never an unexplained process exit.
6. Keep gateway and Feishu credentials out of source control, prompts,
   generated logs, and capability evidence.
7. Survive MetaBot/PM2 and machine restarts without interactive password entry.
8. Allow Skills and MCP servers to extend business workflows only where Claude
   Code has no equivalent native capability or where an explicit external
   system connection is required.

## Non-goals

- Building a general Anthropic-to-OpenAI translation proxy.
- Reimplementing Claude Code, its PTY protocol, or its built-in tools.
- Automatically believing or enabling gateway-advertised capabilities.
- Enabling the unverified 1M context route.
- Adding OCR, image captioning, or a second model call before the main turn.
- Adding Tavily, another search API, or a web-search MCP as a workaround for
  the current gateway failure.
- Disabling a native Claude Code tool merely because the current gateway build
  does not yet support it.
- Using capability probes as automatic runtime feature flags.
- Changing the flywheel schema or reading flywheel data back into agents.

## Architecture

The implementation has four bounded components:

1. **Compatibility profile** — a conservative, versioned declaration of what
   the selected gateway/model/Claude Code combination may use.
2. **Loopback request adapter** — an in-process HTTP proxy owned by MetaBot. It
   rewrites only the proved-broken image shape and streams all responses
   without interpretation.
3. **Claude launch and native-tool policy** — injects the adapter URL, preserves
   Claude Code's native tools, and enforces the model allowlist in both PTY and
   SDK backends. It does not inject a replacement web MCP.
4. **Capability probe** — an explicit deployment/diagnostic command that
   records sanitized evidence. It never runs on every bot turn or every
   ordinary restart.

```text
Feishu attachment
      |
      v
MetaBot downloads into the bot-isolated downloads directory
      |
      v
Claude Code Read tool
      |
      v
tool_result.content[image]
      |
      v
127.0.0.1 compatibility adapter
      |  promotes image to sibling user content block
      v
nexcor gateway -> Opus

Claude web request
      |
      v
Claude Code native WebSearch/WebFetch
      |
      v
compatibility adapter: byte-for-byte pass-through
      |
      v
configured gateway/upstream
      |
      +-- supported: native result returned normally
      |
      `-- unsupported: tool error returned to Claude Code; its final
          explanatory answer is delivered instead of a red process error
```

The adapter belongs inside the MetaBot process rather than a separate daemon.
This gives it the same lifecycle as the bridge, avoids another launchd/PM2
unit, and lets every Claude child receive a fresh loopback URL after restart.

## Compatibility profile

The first profile is named `nexcor-opus-4-8-claude-code-2.1.207`. It contains
these effective decisions:

```ts
interface ClaudeCompatibilityProfile {
  id: 'nexcor-opus-4-8-claude-code-2.1.207';
  allowedModels: readonly ['claude-opus-4-8'];
  contextWindow: 200_000;
  promoteToolResultImages: true;
  nativeWebTools: readonly ['WebSearch', 'WebFetch'];
  nativeToolFailureMode: 'recoverable-turn';
}
```

The profile must not add `WebSearch` or `WebFetch` to PTY
`--disallowedTools`, SDK `disallowedTools`, or generated settings. It must not
mount a search MCP. Existing generic Skill/MCP seams remain available for
future explicit business integrations, but this compatibility profile does
not populate them.

The profile is selected explicitly with
`METABOT_CLAUDE_COMPAT_PROFILE=nexcor-opus-4-8-claude-code-2.1.207`. There is
no automatic fuzzy match based on model names or gateway marketing tags.

MetaBot resolves the configured Claude executable at startup and runs
`claude --version`. The result must be exactly `2.1.207` for this profile. A
different or unreadable version refuses to start Claude executors and requires
a new probe/profile; it is not treated as a warning-only condition. Production
bootstrap installs the exact CLI version and does not auto-upgrade it.

If a configured Claude model is not in `allowedModels`, MetaBot rejects the
Claude bot configuration at startup and reports the bot name plus disallowed
model. Session-level `/model` choices are filtered by the same allowlist. No
`--fallback-model` argument is supplied.

The deployment also changes the private `agentops` Claude settings default to
`claude-opus-4-8` and removes the Fable-specific default environment entry.
The settings file is backed up first and remains mode `0600`. The gateway token
is not changed or printed.

## Loopback request adapter

### Listener and authentication

- Bind to `127.0.0.1` on an OS-assigned port.
- Never bind to a LAN/public interface.
- Accept only requests whose Anthropic authorization header matches the token
  already configured for MetaBot.
- Capture the upstream base URL before starting children; override
  `ANTHROPIC_BASE_URL` in each Claude child environment and in the generated
  Claude settings passed with `--settings`.
- Forward the existing Anthropic authorization and version headers unchanged.

The dual override is mandatory. A deterministic two-listener probe proved that
Claude Code 2.1.207 gives `--settings` `env.ANTHROPIC_BASE_URL` precedence over
the process environment for both its base-URL preflight and the actual message
request. `createHookBridge()` therefore merges settings in this order:

```text
existing private user settings
  -> MetaBot hooks
  -> compatibility env overrides (loopback URL wins last)
```

The original upstream URL remains only in the parent adapter configuration; it
must not survive in the generated child settings.

The adapter exposes the upstream path space transparently. Requests other than
`POST /v1/messages` are streamed through without buffering or modification.

### Image promotion transform

For `POST /v1/messages`, the adapter buffers at most 64 MiB and inspects JSON.
If no exact promotable shape is present, it forwards the original request bytes
unchanged; it does not parse and reserialize every Claude request. For every
`tool_result` whose nested content array contains a supported Anthropic image
block:

1. Keep the `tool_result`, its `tool_use_id`, and all non-image content.
2. Remove only nested blocks with `type: "image"` and a base64 source whose
   media type is `image/jpeg`, `image/png`, `image/gif`, or `image/webp`.
3. Insert a short text block in the nested result if removing the image would
   otherwise leave it empty: `The requested image is attached as a sibling content block.`
4. Insert each removed image as a top-level sibling immediately after its
   owning `tool_result` in that same user message.
5. Preserve existing top-level images, documents, citations, unknown blocks,
   message ordering, tools, thinking settings, cache controls, and model.

The transform is idempotent for already-promoted requests. Deduplication is
scoped to one user message and keyed by `media_type + SHA-256(base64 data)`: a
nested image whose source already exists as an identical sibling is removed but
not appended a second time. Identical images in different historical messages
remain in their original turns, and different images are never coalesced.

Target requests use lossless JSON number handling so unknown numeric fields do
not suffer JavaScript precision changes. Unknown keys and values survive the
rewrite. The adapter applies promotion only when the full known broken shape is
present; if structural validation is inconclusive, it fail-safes to the
original unmodified bytes rather than attempting a partial transform.

PDF/document blocks are never promoted because both validated PDF shapes work.
Malformed JSON or an oversized body returns an Anthropic-shaped
`invalid_request_error`; the request is not partially forwarded. An unsupported
or structurally ambiguous image block does not match the exact transform and
therefore causes the original request bytes to pass through unchanged.

### Response handling

Response status, headers, bytes, and SSE event order pass through unchanged.
The adapter must not parse thinking blocks, signatures, tool input deltas, or
response text. It performs no automatic retry for `POST /v1/messages`, because
an ambiguous retry could bill or execute the same turn twice.

Safe metadata GET requests may retry once after a connection failure. If the
upstream connection fails before headers, the adapter returns an
Anthropic-shaped `api_error` with HTTP 502 and no `Retry-After`, allowing Claude
Code's built-in transient-error policy to decide whether to retry. Adapter
validation failures return HTTP 400 with `invalid_request_error`, which Claude
Code must not retry. Contract tests run the real Claude Code client against
both envelopes to prove the 502 path retries and the 400 path does not. If an
SSE stream fails after headers, the socket closes and the existing executor
lifecycle handles the failed turn.

## Claude Code native web tools

`WebSearch` and `WebFetch` remain Claude Code-owned tools. MetaBot does not
reimplement their schemas, translate them to another provider, add a search
API key, or replace them with an MCP server. Both PTY and SDK launch paths must
leave the tools exposed exactly as Claude Code provides them.

The loopback adapter treats native web requests as non-target traffic. Unless
the request also contains the exact nested-image shape defined above, request
bytes, server-tool declarations, headers, response status, response bytes, and
SSE order pass through unchanged. In particular, the adapter must not remove,
rename, downgrade, or synthesize `web_search_20250305`.

The current gateway's Bedrock route cannot execute that server tool. This is an
upstream capability defect, not a reason to change the agent architecture.
The gateway owner is being asked either to support the native server tool on
the selected route or route such requests to a compatible Anthropic backend.
When that change lands, MetaBot must regain search without a code or bot-config
change.

Until then, failure is fail-soft:

1. Claude Code invokes the native tool and receives the upstream tool/API
   error.
2. Claude Code may continue the same turn and explain that live access is
   unavailable.
3. If a non-empty final assistant answer exists, MetaBot sends it normally and
   records the tool failure as diagnostic metadata; it does not render the
   turn as a red process error.
4. If the Claude process exits abnormally and produces no usable assistant
   answer, the existing process-error behavior remains unchanged.

MetaBot does not retry a native server-tool POST, because the provider or
Claude Code owns retry semantics and an adapter retry could duplicate cost or
side effects. It also does not automatically disable a tool based on the
capability probe; keeping the native path exposed makes a gateway repair take
effect immediately and keeps production behavior aligned with local Claude
Code reproduction.

Skills may teach Marketing, HR, or other bots when and how to use native web
tools. MCP remains appropriate for systems Claude Code does not natively
connect to, such as a private HR system or an internal document service. A
Skill or MCP may not claim to be Claude Code's native WebSearch/WebFetch, and
adding one requires its own explicit design and authorization.

## Claude launch integration

`PtyQueryOptions` and `PtyClaudeSessionOptions` gain explicit child-environment
and settings-environment inputs. The SDK query path receives the equivalent
SDK options. No web-specific denied-tool or MCP configuration is injected.
The existing hook-settings merge behavior is preserved.

Both backends receive the same child environment:

- `ANTHROPIC_BASE_URL=<loopback adapter URL>`
- the existing Anthropic token
- the existing Claude Code settings and context controls
- no Fable default or fallback

The generated Claude settings receive the same loopback
`ANTHROPIC_BASE_URL`. This later merge is the authoritative value because
Claude Code applies settings env after process env.

The adapter starts before any Claude executor can be created and stops after
all executors are drained. If the selected profile requires the adapter and it
cannot bind, MetaBot refuses to start Claude executors instead of silently
routing around it.

## Capability probe and evidence

Add an explicit command that probes a specified gateway/model without changing
production bot state. The command covers:

1. `/v1/models` metadata and supported endpoint types.
2. basic text, non-streaming and streaming.
3. ordinary client tool use.
4. direct top-level image recognition using a deterministic fixture.
5. nested tool-result image recognition, both before and after promotion.
6. direct and nested PDF recognition using a deterministic generated PDF.
7. prompt-cache usage fields.
8. native `WebSearch`, classified as `available`, `upstream_unsupported`,
   `transport_error`, or `unexpected_error`;
9. native `WebFetch`, classified separately so domain verification is not
   confused with server-tool support.

Probe output contains only status, latency, response block types, selected
model, sanitized error category, and pass/fail assertions. It never writes
prompts, image/PDF base64, response thinking/signatures, authorization headers,
or credential values.

Evidence is stored at
`~/.metabot/capabilities/<profile-id>.json` with mode `0600`. It is diagnostic
evidence, not an automatic feature toggle. A new gateway build, Claude Code
version, or selected model requires a new probe before the compatibility
profile can be relaxed.

The 2026-07-14 baseline records native WebSearch as `upstream_unsupported`
because the gateway returned `aws_invoke_error` / Bedrock HTTP 400 for
`web_search_20250305`. The probe must not encode this failure as the desired
permanent result. After the provider announces a repair, the same probe must
change to `available` and report a positive native search request count.

## Error handling and user experience

- A capability-specific error does not terminate MetaBot or unrelated bot
  sessions.
- Adapter validation errors retain an Anthropic-compatible error envelope so
  Claude Code can surface a meaningful turn failure.
- A native web-tool error followed by a non-empty Claude final answer is a
  completed turn. MetaBot sends that answer and does not replace it with
  `claude process exited before the turn completed`.
- A process exit with no usable assistant answer remains a real failed turn;
  MetaBot must not fabricate a success message.
- Native tool errors are recorded only as sanitized category, provider status,
  and tool name. Provider messages, prompts, queries, and credentials are not
  copied into ordinary logs.
- The existing image-stripping fallback remains in place during development.
  It is removed only after the real Claude Code image acceptance test passes
  through the adapter. There must never be a deployment gap in which images can
  once again terminate a turn.
- Logs may include profile ID, bot name, request path, HTTP status, duration,
  request byte count, number of promoted image blocks, and error category.
  They may not include message bodies, filenames, prompts, response text,
  image/document bytes, thinking, signatures, or authentication headers.

## Security boundaries

The operating-system user boundary remains the primary isolation mechanism.
All runtime components execute as `agentops`; development continues as `neo`.
The compatibility work does not grant agents access to `/Users/neo`.

The adapter does not create a new public surface. Loopback binding and token
validation prevent unauthenticated local callers from using it as an open
gateway. Generated hook settings and capability evidence are private to
`agentops`.

Native WebSearch/WebFetch use Claude Code and the configured gateway/provider,
so their normal provider data boundary still applies. Bot instructions must
not put candidate files, employee records, credentials, or unrelated private
conversation content into a public search query. HR-specific workflow and
privacy guidance belongs in the HR Skill; it does not require replacing or
globally disabling Claude Code's native tool.

## Testing

### Unit tests

- Exact image promotion with one and multiple tool results.
- Idempotency when the image already exists as a sibling.
- Three-turn persistent-history replay with two distinct images, proving each
  historical user message contains exactly one matching promoted image.
- PDF and unknown content blocks remain untouched.
- Any valid non-target request is forwarded byte-for-byte; target requests
  retain unknown fields and lossless numeric values.
- Malformed and oversized bodies return the specified error; unsupported or
  ambiguous image shapes pass through unchanged.
- Fable and every non-allowlisted model are rejected at configuration and
  session `/model` boundaries.
- PTY and SDK launch options both leave `WebSearch` and `WebFetch` exposed,
  receive the same adapter URL, and inject no replacement web MCP.
- A native tool error followed by a successful Claude result with non-empty
  assistant text is delivered as a normal answer.
- A failed Claude result without usable assistant text remains a failed turn.
- Log records contain metadata but no fixture prompt, base64, or token marker.

### Adapter integration tests

A local fake Anthropic upstream verifies:

- non-message requests pass through byte-for-byte;
- ordinary JSON requests are unchanged;
- transformed requests match the validated promoted-image wire shape;
- streaming SSE status, headers, chunks, and ordering are unchanged;
- upstream failures map to the documented error behavior without retries for
  message creation.
- real Claude Code retries the adapter's transient 502 envelope but does not
  retry the adapter's validation 400 envelope.

### Native web-tool tests

- PTY argv contains no `--disallowedTools WebSearch WebFetch` entry.
- SDK options do not deny `WebSearch` or `WebFetch`.
- No Tavily dependency, key, generated config, prompt instruction, or MCP
  server is introduced.
- A deterministic fixture reproduces a `WebSearch` tool failure followed by a
  successful final assistant explanation; the bridge sends the explanation
  and does not emit a red process error.
- A deterministic fixture with no final assistant content still emits the
  existing process error.
- Non-image requests containing native server-tool declarations pass through
  the loopback adapter byte-for-byte.

### Live acceptance

Live probes always use the explicit model `claude-opus-4-8`. The acceptance
sequence is:

1. Start a test Claude executor through the real PTY backend and adapter.
2. Require an exact text marker and one normal local tool call.
3. Send the existing deterministic Feishu screenshot through `Read`; require
   the exact answer `Metabot` and no `Content block not found` error.
4. Continue the same persistent session for three image turns using two
   different fixtures; require correct recognition, no duplicate promoted
   images, and non-zero `cache_read_input_tokens` after promotion.
5. Send the deterministic PDF; require the exact code `ORBBEC-7429`.
6. Before the gateway repair, invoke native WebSearch and require a truthful
   final explanation with no red MetaBot process error; evidence must classify
   the tool as `upstream_unsupported` and report zero completed search calls.
7. After the gateway owner reports a repair, repeat the identical command and
   require a positive native web-search request count plus cited live results.
8. Test native WebFetch independently against a known safe URL and the original
   failing URL so domain verification is diagnosed separately.
9. Restart MetaBot/PM2 without an interactive password and repeat the markers.
10. Send one smoke message to each of the six Feishu bots.
11. Confirm logs and flywheel records contain no credential, base64 attachment,
   thinking, or signature content.

## Deployment and rollback

Development and automated testing occur in `metabot-dev`. Deployment copies
only verified source/build/config artifacts to the `agentops` runtime, then
rebuilds and restarts as `agentops` through the existing non-interactive
operational path.

Before deployment, back up:

- the current MetaBot runtime source/build;
- private Claude settings;
- bot configuration and bootstrap environment;
- the current PM2 process description.

Deployment first verifies the adapter with the real screenshot and PDF. It then
removes the temporary image-stripping fallback, rebuilds, restarts PM2, and
runs all six bot smoke messages. This is a short verification gate, not a
long-lived staged rollout; the bots are not yet publicly used.

Rollback restores the previous MetaBot runtime and private Claude settings,
restarts PM2, and re-enables the image-stripping fallback. Rollback never
selects Fable. Native web-tool upstream failure is not a deployment rollback
trigger when Claude Code completes the turn with a usable explanation; text,
local tools, images, and PDFs must continue operating.

## Implementation decomposition

The design will be implemented as two independently reviewable plans:

1. **Core gateway compatibility** — profile/model guard, loopback adapter,
   image promotion, Claude launch integration, probe command, tests, and
   removal of the temporary image fallback after live verification.
2. **Native web-tool reliability** — byte-for-byte native tool pass-through,
   recoverable final-answer handling, separate WebSearch/WebFetch capability
   evidence, current-failure fixture, and post-provider-fix live acceptance.

Neither plan installs a web provider, creates a search credential, or mounts a
replacement search MCP. Marketing Bot remains usable while the gateway repair
is pending because a recoverable native tool failure must produce a normal,
truthful answer instead of terminating the turn. Live-search acceptance is
complete only after the unchanged native Claude Code probe succeeds against
the repaired gateway.
