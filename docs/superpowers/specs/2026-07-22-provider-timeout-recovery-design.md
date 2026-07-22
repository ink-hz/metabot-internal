# Provider timeout recovery and staged artifact delivery

## Problem

On 2026-07-22 the Marketing GTM Bot accepted a request to create a customer-facing PowerPoint and an internal sales script. The first model request and a read-only `pandoc` preflight succeeded, but the follow-up provider stream emitted a short progress sentence and then became silent. Claude Code wrote a terminal JSONL record containing `API Error: The operation timed out.` after roughly 244 seconds without another stream event. MetaBot discarded that text while synthesizing the PTY result, reduced the failure to `Ended with: error`, classified it as `unknown`, and displayed `UNEXPECTED_FAILURE`.

The failed turn did not write or upload a file. A manual retry succeeded only after the artifact work was decomposed into batches of at most four slides, each batch was written to disk, conversion was performed after the source was complete, and delivery happened only after validation. A separate resume attempt exposed a second failure: the Claude TUI displayed an idle input box, but PTY readiness timed out; the Claude process closed while the async task remained `running` until the isolated Bot instance was restarted.

## Decision

Treat provider timeout recovery as a stateful turn-recovery problem, not as a reason to wait indefinitely. Preserve a sanitized provider error envelope through the PTY adapter, classify retryable provider failures explicitly, retry at most once when replay is safe, and terminalize every PTY startup or prompt-loop failure. Long artifact tasks use deterministic stage checkpoints so recovery resumes missing work instead of replaying completed generation or delivery.

Increase the Claude client request timeout from 300,000 ms to 600,000 ms only as a defensive ceiling. Production rollout must first verify that the Nexcor upstream and every intervening proxy allow a response stream to remain open for at least 600,000 ms or emit an SSE heartbeat at least once every 60,000 ms. MetaBot's existing 24-hour task ceiling and one-hour stream-idle ceiling remain unchanged.

## Error envelope and classification

The PTY layer will extract only bounded, non-sensitive fields from a terminal API-error JSONL record:

- normalized error kind;
- numeric HTTP status when present;
- sanitized message capped at 500 characters;
- whether any assistant text was observed;
- whether a tool classified as having a side effect was observed;
- elapsed request time and time since the last stream record when available.

The synthesized SDK-compatible result will carry this envelope in `errors` and retain `is_error=true`. It will never include prompts, credentials, request headers, raw thinking, complete terminal contents, or unrestricted upstream response bodies.

Classification rules are deterministic:

- timeout text, timeout kinds, and response-aborted-after-idle conditions map to `timeout`;
- HTTP 429 maps to `gateway_transport` with internal retry reason `provider_capacity`;
- HTTP 502, 503, 504, connection reset, refused connection, unreachable network, and socket hang-up map to `gateway_transport`;
- malformed requests, authentication failures, permission failures, model mismatch, context overflow, and invalid sessions retain their existing specific classes and are not treated as generic transport failures;
- unrecognized provider failures remain `provider_error`, not `unknown`; `provider_error` receives the stable public code `MODEL_PROVIDER_ERROR`.

The public card must show an actionable stable code. A provider timeout shows `TASK_TIMEOUT`; a gateway transport failure shows `MODEL_GATEWAY_UNAVAILABLE`. Internal logs and Flywheel keep the sanitized class and bounded message.

## Safe retry policy

A provider failure is automatically replayed once only when all of the following are true:

- the failure is `timeout`, HTTP 429, `gateway_transport`, or another explicitly allowlisted transient provider condition;
- the user did not stop the task;
- no external side effect has occurred;
- the provider did not complete a usable terminal answer;
- the attempt count is below two total attempts.

The replay starts a fresh Claude session and uses the original user request plus a bounded recovery note. It waits 2,000-5,000 ms with jitter before reacquiring the existing cross-instance gateway turn lease. A second transient failure is terminal and returns any validated local artifacts already produced.

Tool effects use three classes:

1. `read_only`: inspection commands and file reads; safe to replay.
2. `local_idempotent`: deterministic writes, appends guarded by stage state, conversion to a deterministic staging path, and validation; resume from the last completed checkpoint instead of replaying the whole turn.
3. `external_side_effect`: messages, uploads, remote writes, scheduling, publication, or commands whose effect is unknown; never replay automatically.

Unknown tools default to `external_side_effect`. Existing process-exit recovery will consume the same effect classification so a harmless `which`, `ls`, or read-only preflight no longer prevents a safe replay.

## PTY lifecycle guarantees

Every path that prevents a prompt from reaching Claude must produce a terminal result or reject the stream; it must never only log and dispose the process.

- Initial readiness timeout fails the current turn with `claude_session` and closes the async task.
- Per-turn idle-input timeout may type through only when the rendered screen still contains an unblocked input marker; otherwise it fails terminally.
- A prompt-loop exception fails the output queue with structured phase metadata.
- A closed PTY stream with no terminal result becomes `CLAUDE_SESSION_FAILED`, not a successful empty stream.
- The first readiness failure for an existing resumed session resets only the Claude session mapping and performs one fresh-session retry when no external side effect has occurred.
- Async task state reaches `completed` or `failed` on every stream, launch, card-delivery, and cleanup path.

The historical session remains discoverable in the session registry; clearing the active resume mapping does not delete its Claude JSONL or session history.

## Staged artifact contract

Long document tasks use a job-local staging directory outside the user-visible outputs directory. A small JSON checkpoint records only stage names, deterministic artifact paths, byte sizes, and validation results. It contains no document body or customer data.

The ordered stages are:

1. `source_batches`: write or append bounded source batches; each batch has a stable identifier and may be committed once.
2. `source_complete`: verify required sections and placeholder policy.
3. `convert`: generate the requested binary format to a deterministic staging path.
4. `validate`: require non-empty files and format-specific integrity checks.
5. `publish_outputs`: copy validated final artifacts to the MetaBot outputs directory.
6. `deliver`: upload each artifact with an idempotency fingerprint of chat ID, turn ID, filename, size, and SHA-256.
7. `delivered`: persist the returned platform file key or message ID so recovery never sends the same artifact twice.

The GTM Bot prompt will require batches of no more than four slides for PowerPoint authoring and will require Markdown source plus the internal script to remain deliverable fallbacks. Missing company facts continue to use structured placeholders. The generic document-output rule will require incremental writes for long files without imposing GTM-specific content on other Bots.

## Gateway adapter observability

The compatibility adapter will log one bounded record for request start and one for each terminal transport state:

- completed response;
- upstream request error before headers;
- response aborted or closed before normal finish;
- downstream close;
- local adapter rejection.

Records include method, path, status, duration, request byte count, response byte count when known, and milliseconds since the last response chunk. They exclude authorization headers, bodies, prompts, customer content, and URLs containing credentials.

An adapter-level POST retry is not added. Retrying below the turn coordinator cannot determine whether tools or delivery side effects already occurred and could duplicate actions.

## Configuration and rollout

The 600,000 ms Claude request ceiling is an explicit deployment-contract value rather than an undocumented value in a user settings file. Deployment verification checks the effective child settings without printing credentials. Rollout order is:

1. error envelope, classification, and observability;
2. PTY terminal-state guarantees;
3. safe one-retry coordinator with effect classification;
4. staged artifact checkpoints and GTM prompt rule;
5. upstream idle-timeout or heartbeat verification;
6. request-ceiling increase;
7. isolated Marketing GTM deployment and production smoke.

If upstream stream lifetime cannot be verified, keep the 300,000 ms ceiling and ship the recovery/checkpoint work first.

## Implementation slices

This design ships as three independently testable slices rather than one cross-repository change:

1. **Core recovery:** sanitized provider-error propagation, classification, PTY terminal-state guarantees, effect classification, and one safe fresh-session replay in `metabot-dev`.
2. **Artifact recovery:** checkpoint helper, output-delivery idempotency, generic long-document discipline, and the GTM-specific four-slide batching rule across `metabot-dev` and `Orbbec-Agent-Team`.
3. **Timeout rollout:** explicit deployment contract, upstream stream-lifetime or heartbeat verification, 600,000 ms client ceiling, isolated GTM deployment, and production smoke.

Core recovery ships first because it turns silent or misleading failures into terminal, classifiable states and is a prerequisite for safely testing either later slice.

## Verification

Automated tests must prove:

- `API Error: The operation timed out.` survives PTY synthesis in sanitized form and maps to `TASK_TIMEOUT`;
- 429 and 502/503/504 provider failures map to retryable classes;
- malformed/authentication/model/session errors are not retried;
- one transient pre-side-effect failure replays once in a fresh session;
- a second failure terminates without a third attempt;
- read-only tools permit replay, deterministic local writes resume from checkpoints, and external/unknown side effects forbid replay;
- a PTY readiness or prompt-loop failure terminalizes both the turn and async task;
- an existing resumed session receives one safe fresh-session fallback;
- adapter response aborts and closes create bounded diagnostic records;
- checkpoint recovery does not duplicate source batches or attachment delivery;
- the existing process-exit, stale-session, context-overflow, gateway-lease, attachment, Flywheel, and public-error suites remain green.

Production acceptance uses an isolated GTM Bot instance and a synthetic staging chat first. It must complete a multi-file PowerPoint task with forced transient provider failure, resume from the last checkpoint, deliver each artifact exactly once, produce a terminal async-task state, and expose the correct public error if the forced retry also fails. A real-user smoke follows only after the synthetic run passes.

## Non-goals

- Infinite retries or replay after an unknown/external side effect.
- Raising MetaBot's 24-hour task ceiling or one-hour stream-idle ceiling.
- Persisting prompts, raw thinking, credentials, or unrestricted upstream errors in logs.
- Hiding partial success when validated files already exist.
- Treating a longer timeout as a substitute for checkpointed artifact generation.
- Replacing the shared gateway compatibility profile or changing the configured Claude model in this work.
