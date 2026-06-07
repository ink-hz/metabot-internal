---
name: metabot-team
description: "Use when coordinating or working inside a MetaBot Agent Team via `metabot teams`: create/list teams, spawn teammates, exchange messages, manage shared tasks, inspect runs, and report status to the lead."
---

# MetaBot Agent Team

MetaBot Agent Teams mirror the compact Claude Agent Teams workflow, but the
coordination model is MetaBot-native and engine-neutral. Teammates may be
declared as Claude, Codex, Kimi, or future engines, but execution still goes
through the current bridge/session-engine path. Do not assume every engine can
handle every workflow until runtime capability validation or per-engine
adapters are added.

## Core Model

Team = Agents + Messages + Tasks + Runs.

Use the CLI for all team coordination. Plain chat output is not visible to
teammates unless you send it through the team mailbox.

## Lead Workflow

```bash
metabot teams create <team> --description "..."
metabot teams agents spawn <team> <name> --role <role> --engine <claude|codex|kimi> --prompt "..."
metabot teams tasks create <team> "<subject>" --description "..."
metabot teams tasks update <team> <taskId> --owner <name>
metabot teams send <team> <name> "Start task <taskId>."
metabot teams runs list <team>
metabot teams status <team>
```

Lead rules:
- Keep the team task list current.
- Assign work with `tasks update --owner`.
- Send teammate instructions with `teams send`.
- Integrate completed work before reporting to the user.
- Stop or delete the team when the work is done.

## Teammate Workflow

```bash
metabot teams inbox <team> <your-name> --unread --read
metabot teams tasks list <team>
metabot teams tasks get <team> <taskId>
metabot teams tasks update <team> <taskId> --owner <your-name> --status in_progress
metabot teams tasks update <team> <taskId> --status completed --result "..."
metabot teams runs list <team>
metabot teams send <team> lead "Completed task <taskId>: ..."
```

Teammate rules:
- Claim a task before working on it.
- Prefer available tasks in ID order.
- Mark a task completed only after the requested verification is done.
- If blocked, leave the task in progress and message the lead.
- After completing a task, check the task list again.

## Runs

Runs are background execution records. The supervisor creates them
automatically when it starts a teammate, but leads and teammates can also use
them for smoke tests or long-running work:

```bash
metabot teams runs list <team>
metabot teams runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs output <team> <runId>
metabot teams runs stop <team> <runId>
```

Run statuses: `running`, `completed`, `failed`, `stopped`.

Stop semantics: `metabot teams runs stop` marks the stored run as `stopped`.
When the supervisor owns the in-flight run, it also asks the bridge to stop the
teammate chat task, requeues assigned in-progress tasks to `pending` with a
stop note, and suppresses late executor output so delayed success cannot
overwrite the stopped run.

Failed-run rules:
- If a manual run fails, update it with `--status failed --error "<reason>"`.
- Inspect failure details with `metabot teams runs output <team> <runId>`.
- The supervisor marks failed or crashed executions as `failed`, records the
  error, requeues assigned in-progress tasks to `pending` with failure context
  in `result`, returns the agent to idle, and sends a failure message to
  `lead` for non-lead teammates.
- Do not manually mark a requeued task completed just because a failed run
  produced partial output; let the supervisor retry it or ask the lead whether
  to reassign/stop it.

## Supervisor Behavior

The bridge supervisor scans active teams for agents with unread messages or
assigned pending tasks. It creates a run, marks the agent working, runs that
agent in chat `team:<team>:<agent>`, records output or error, then returns the
agent to idle. Non-lead teammates send a completion or failure message to
`lead`.

Operational knobs:
- `METABOT_AGENT_TEAM_SUPERVISOR=0` disables the loop.
- `METABOT_AGENT_TEAM_SUPERVISOR_INTERVAL_MS` changes the polling interval.
- The supervisor sets the configured session engine for the teammate chat, but
  currently does not validate engine capabilities before dispatch.

## Card Display

Feishu cards use the team store snapshot:
- Team panel: agents, working/idle state, and visible tasks.
- Background activity panel: runs, status, latest output, or latest error.
- Deleted tasks are hidden from cards.
- Cards are chat-scoped: teams display only when the current chat matches
  `displayChatIds` or `chatIds`; active teams are not displayed globally.

## Resident `bots.json` Teams

For persistent teams, configure `agentTeams` in `bots.json`. The bridge
reconciles these teams at startup and hot-reloads them unless
`METABOT_AGENT_TEAMS_HOT_RELOAD=0` is set.

```json
{
  "agentTeams": [
    {
      "name": "metabot-dev",
      "description": "MetaBot implementation team",
      "status": "active",
      "chatIds": ["team:metabot-dev:cli-engineer", "team:metabot-dev:runtime-engineer"],
      "displayChatIds": ["oc_feishu_chat_id"],
      "agents": [
        { "name": "cli-engineer", "role": "implementation", "engine": "codex", "prompt": "Own teams CLI, command UX, tests, and docs." },
        { "name": "runtime-engineer", "role": "runtime", "engine": "codex", "prompt": "Own bridge runtime, store, supervisor, and cards." }
      ],
      "tasks": [
        { "id": 8, "subject": "Document Agent Teams workflow", "owner": "cli-engineer", "status": "pending" }
      ]
    }
  ]
}
```

Use `chatIds` for teammate execution chats like `team:<team>:<agent>`. Use
`displayChatIds` for user-facing Feishu chats where the Team and Background
card sections should appear.

`lead` is not globally reserved. For a top-level team, the current user-facing
bot can be the leader; if no active `lead` member exists, messages sent to
`lead` are surfaced through Agent Activity. Nested/sub-project teams may still
define their own `lead` member, which then runs in `team:<team>:lead`.

Rollout caveat: on existing DBs, the `managed_by_config` column defaults false
when the migration first adds it. Pre-existing resident teams are not eligible
for config-removal stop behavior until they have been reconciled from
`bots.json` once. After deploying this change, restart the bridge or trigger
one hot reload with the desired `agentTeams` still present before relying on
removing a team from config to stop that resident team.

## Minimal Tool Equivalents

| Claude Agent Teams | MetaBot CLI |
| --- | --- |
| TeamCreate | `metabot teams create` |
| TeamDelete | `metabot teams delete` |
| Agent | `metabot teams agents spawn` |
| ListAgents | `metabot teams agents list` |
| SendMessage | `metabot teams send` / `metabot teams inbox` |
| TaskCreate/List/Get/Update | `metabot teams tasks ...` |
| TaskOutput/TaskStop | `metabot teams runs output/stop` |
