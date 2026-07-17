# Cross-instance Claude gateway turn scheduler

## Problem

The per-Bot deployment correctly isolates PM2 processes, ports, state, logs, and Feishu ownership, while all PTY Bots share one Nexcor Claude gateway. Sequential deployment probes pass, but simultaneously mentioning the three Marketing Bots starts three Claude turns at once. The observed production result was one long-running Claude child and two early process exits. The current queue is scoped to one chat inside one MetaBot process, so it cannot coordinate gateway use across Bot instances.

## Decision

Keep the approved one-process-per-Bot topology and the shared gateway compatibility layer. Add a file-backed, cross-process turn lease immediately before a PTY prompt is submitted. The default fleet concurrency is one active PTY turn. SDK Bots do not use the scheduler.

The lease is shared by every MetaBot instance through an explicit `METABOT_CLAUDE_GATEWAY_LOCK_DIR` environment variable. It is not stored under an instance-specific `TMPDIR`. Waiting turns remain inside their owning Bot process and acquire the lease in FIFO-like polling order; they do not spawn retries or compete with the active turn.

## Components

### Gateway turn lease

A focused module owns atomic acquisition and release:

- Acquisition uses atomic directory creation.
- The owner record contains only PID, a random nonce, instance name, and acquisition time.
- A contender waits with bounded polling when the owner process is alive.
- A lock whose owner PID is dead is atomically renamed to quarantine and removed before acquisition is retried.
- Release checks the nonce and never deletes a newer owner's lease.
- Cancellation stops a queued acquisition without touching the active owner.

No credentials, prompts, chat IDs, or customer data are written to the lease.

### PTY lifecycle integration

`ptyQuery` acquires the lease after its Claude session is ready but before `typePrompt`. It releases exactly once on every terminal path:

- Stop-hook completion;
- terminal API error;
- keep-planning and slash-command synthetic completion;
- user interruption;
- unexpected Claude exit;
- normal disposal or boot failure.

Only the active model turn holds the lease. An idle persistent Claude process does not hold it, so another Bot may run.

### Deployment contract

Every generated PM2 instance receives the same absolute lock directory. The deployment creates it with `agentops` ownership and mode `0700`. The compatibility Profile remains mandatory and unchanged.

## Failure behavior

- Simultaneous Bot mentions are serialized instead of producing concurrent gateway exits.
- A crashed MetaBot owner cannot permanently block the fleet because its PID becomes stale.
- A live but genuinely long-running turn is not stolen; stealing a live lease could duplicate tool side effects.
- `/stop` interrupts the owning turn and releases the lease.
- A stopped queued turn cancels its wait without disturbing the active Bot.
- Gateway errors after acquisition continue through the existing single safe replay policy; the replay must reacquire the lease.

## Verification

Automated tests must prove mutual exclusion across independent lease clients, stale-owner recovery, nonce-safe release, cancelled waiting, and release on every PTY terminal path. The existing MetaBot suite, compatibility smoke, and deployment contract tests must remain green.

Production acceptance is not `/api/health`. It requires one simultaneous three-Bot request: all three Marketing Bots must reach a terminal successful response, no Claude process-exit card may appear, the maximum observed active gateway turns must be one, and the three instances must retain distinct state/log directories while reporting the same Release SHA and compatibility Profile.

## Non-goals

- Reverting to one MetaBot process.
- Copying or forking MetaBot source per Bot.
- Changing Marketing prompts or FAE/HR business behavior.
- Automatically replaying a turn after tool side effects.
