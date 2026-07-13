# Claude PTY Settings Merge Design

## Problem

MetaBot's PTY backend launches Claude with a generated `--settings` file that
contains only MetaBot's command hooks. Claude treats that file as the active
settings source, so user settings such as `theme`, enabled plugins, proxy
environment values, and `skipDangerousModePermissionPrompt` are lost.

On a fresh runtime account this blocks the PTY on Claude's onboarding or
bypass-permissions confirmation screens. MetaBot then types the user's message
into the menu and eventually reports that Claude exited before completing the
turn.

## Design

`createHookBridge()` will read the runtime user's existing
`~/.claude/settings.json`, when it is valid JSON, and use it as the base for the
generated PTY settings. It will merge MetaBot's hooks into the base `hooks`
object. Existing hook event arrays remain present; MetaBot appends its own Stop
hook instead of replacing user hooks.

The generated bridge directory will be mode `0700` and the generated settings
file mode `0600`, because the copied user settings may contain authentication
environment variables. Invalid, missing, or non-object user settings will fall
back to a hooks-only configuration so PTY startup remains available.

No Feishu bot configuration, model selection, backend selection, or Claude
credential will be changed by this patch.

## Verification

Automated tests will prove that:

1. User settings survive generation.
2. Existing hooks are retained and MetaBot's Stop hook is appended.
3. Missing or invalid user settings fall back safely.
4. Generated directory and file permissions are private.

After unit tests and the existing MetaBot test suite pass, a real local smoke
test will invoke the same Claude 2.1.207 arm64 binary through MetaBot's
`ptyQuery()` and require a known model-response marker. Only then will the
verified source patch, native Claude installation, and executable
`node-pty/spawn-helper` be deployed to `agentops` in one operation.

## Deployment and rollback

The deployment will back up the affected MetaBot source/build and Claude
installation before replacement, rebuild as `agentops`, restart the PM2
process, and run a runtime smoke test. Rollback restores the backup and restarts
the previous PM2 process if any deployment verification fails.
