# Opus Gateway Compatibility Layer Design

## Status

- Date: 2026-07-14
- Scope: MetaBot Claude engine, the `agentops` runtime, and all six Feishu bots
- Selected model: `claude-opus-4-8`
- Selected approach: local request adapter plus MCP replacements for incompatible web tools
- Explicitly prohibited: any request, fallback, probe, or model-selection path that can invoke Fable

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
| Built-in `WebSearch` | Fail; upstream rejects server tool type | Deny and replace with MCP |
| Built-in `WebFetch` | Fail during domain-safety verification | Deny and replace with MCP |
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
4. Replace only the two incompatible built-in web tools.
5. Convert unsupported-capability failures into controlled tool or turn errors,
   never an unexplained process exit.
6. Keep gateway, Feishu, and web-provider credentials out of source control,
   prompts, generated logs, and capability evidence.
7. Survive MetaBot/PM2 and machine restarts without interactive password entry.

## Non-goals

- Building a general Anthropic-to-OpenAI translation proxy.
- Reimplementing Claude Code, its PTY protocol, or its built-in tools.
- Automatically believing or enabling gateway-advertised capabilities.
- Enabling the unverified 1M context route.
- Adding OCR, image captioning, or a second model call before the main turn.
- Supporting arbitrary web-search providers in the first release.
- Changing the flywheel schema or reading flywheel data back into agents.

## Architecture

The implementation has four bounded components:

1. **Compatibility profile** — a conservative, versioned declaration of what
   the selected gateway/model/Claude Code combination may use.
2. **Loopback request adapter** — an in-process HTTP proxy owned by MetaBot. It
   rewrites only the proved-broken image shape and streams all responses
   without interpretation.
3. **Claude launch policy** — injects the adapter URL, denies the incompatible
   built-in web tools, mounts the approved MCP server, and enforces the model
   allowlist in both PTY and SDK backends.
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
      +-- built-in WebSearch/WebFetch: denied before invocation
      |
      `-- Tavily MCP search/extract: allowed
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
  deniedBuiltInTools: readonly ['WebSearch', 'WebFetch'];
  deniedMcpTools: readonly [
    'mcp__tavily__tavily-map',
    'mcp__tavily__tavily-crawl',
  ];
  webMcp: 'tavily';
}
```

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

## Web tools through MCP

Claude Code starts with built-in `WebSearch` and `WebFetch` denied. This is
enforced in both launch paths:

- PTY: add `--disallowedTools WebSearch WebFetch`.
- SDK: set `disallowedTools: ['WebSearch', 'WebFetch']`.

The replacement is the official Tavily MCP server, pinned to npm package
`tavily-mcp@0.2.21`. MetaBot invokes the installed local binary directly; it
does not execute `npx -y`, install `latest`, or download code at bot startup.
The enabled tools are limited to Tavily search and extract for the first
release. The MCP server is named `tavily`, so Claude Code exposes deterministic
tool names. `mcp__tavily__tavily-map` and
`mcp__tavily__tavily-crawl` are included in the same denied-tools launch
policy as the two broken built-ins; map and crawl therefore cannot be invoked.

`TAVILY_API_KEY` is supplied to the `agentops` runtime from Keychain/bootstrap
configuration and written only into the generated private MCP configuration or
child environment. It is never placed in `bots.json`, a project `CLAUDE.md`, or
source control. Known unrelated secrets such as Anthropic and Feishu tokens are
overridden to empty strings in the MCP subprocess environment.

Web-tool policy has three states:

- `required`: startup fails if the package or key is missing. This is the
  production setting for Marketing Bot.
- `optional`: Claude starts without the MCP server if unavailable, while the
  incompatible built-ins remain denied. A clear startup warning is emitted,
  and the appended system prompt explicitly says live web access is unavailable
  and current facts must be qualified rather than guessed from model memory.
- `disabled`: neither built-in nor MCP web tools are exposed.

HR Bot is explicitly `disabled` because candidate and employee content must not
have an available route to Tavily. Marketing Bot is `required` after its key is
provided. `feishu-default`, Product Commercialization, Quality, and FAE default
to `optional` until their scenarios require a stricter policy. A short appended
system-prompt section maps user intent to `tavily-search` and
`tavily-extract`; it never claims that the built-in web tools work.

Tavily is an external service and may have usage charges. This design does not
authorize account creation or spending. Production web-tool acceptance remains
blocked until the owner supplies a key. The official server and authentication
mechanism are documented at <https://github.com/tavily-ai/tavily-mcp>.

## Claude launch integration

`PtyQueryOptions` and `PtyClaudeSessionOptions` gain explicit child environment,
denied-tool, and MCP-config inputs. `PtyClaudeSession` converts them to Claude
Code CLI arguments. The SDK query path receives the equivalent SDK options.

MetaBot generates one private MCP config for each Claude executor, next to the
existing generated hook settings. The containing directory remains mode `0700`
and files remain mode `0600`. The hook-settings merge behavior is preserved.

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
8. built-in server web-search rejection.

Probe output contains only status, latency, response block types, selected
model, sanitized error category, and pass/fail assertions. It never writes
prompts, image/PDF base64, response thinking/signatures, authorization headers,
or credential values.

Evidence is stored at
`~/.metabot/capabilities/<profile-id>.json` with mode `0600`. It is diagnostic
evidence, not an automatic feature toggle. A new gateway build, Claude Code
version, or selected model requires a new probe before the compatibility
profile can be relaxed.

## Error handling and user experience

- A capability-specific error does not terminate MetaBot or unrelated bot
  sessions.
- Adapter validation errors retain an Anthropic-compatible error envelope so
  Claude Code can surface a meaningful turn failure.
- MCP startup errors name the missing server/key but never include its value.
- Tavily request errors return a tool error to Opus; Opus can explain that live
  web access is temporarily unavailable and continue using local knowledge.
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
gateway. Generated hook/MCP configs and capability evidence are private to
`agentops`.

Web search/extract sends the user's search query or requested public URL to
Tavily. It does not send Feishu credentials, Anthropic credentials, arbitrary
local files, or the full conversation by default. Bot instructions must not
ask the web MCP to process HR-private attachments or other sensitive local
content.

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
- PTY and SDK launch options both deny built-in web tools and receive the same
  adapter/MCP configuration.
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

### MCP tests

- Generated MCP config uses the pinned local Tavily binary.
- `required`, `optional`, and `disabled` policies behave exactly as specified.
- missing/invalid keys are reported without disclosure.
- a mocked Tavily server proves search and extract tool availability.
- no unrelated runtime secrets are present in the MCP-specific environment.

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
6. With a configured Tavily key, require one search and one extract result.
7. Restart MetaBot/PM2 without an interactive password and repeat the markers.
8. Send one smoke message to each of the six Feishu bots.
9. Confirm logs and flywheel records contain no credential, base64 attachment,
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
selects Fable. If Tavily alone fails, built-in web tools stay denied and the
remaining Opus capabilities continue operating.

## Implementation decomposition

The design will be implemented as two independently reviewable plans:

1. **Core gateway compatibility** — profile/model guard, loopback adapter,
   image promotion, Claude launch integration, probe command, tests, and
   removal of the temporary image fallback after live verification.
2. **Web MCP replacement** — pinned Tavily MCP package, private generated
   config, deny rules, required/optional/disabled policy, mocked/live tests,
   and Keychain/bootstrap deployment instructions.

The core adapter is usable and testable without a Tavily account. Marketing
Bot is not considered fully accepted until the Web MCP plan passes its live
search/extract checks.
