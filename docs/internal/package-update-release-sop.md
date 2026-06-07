# MetaBot Package Update Release SOP

MetaBot bot hosts should update from the internal package endpoint, not from a
Git remote. This keeps regular users independent of GitLab/GitHub credentials
and makes fresh installs, historical Git checkouts, and tarball installs share
one refresh path.

## User Commands

Regular bot hosts:

```bash
metabot update
```

Fresh install or forced refresh:

```bash
curl -fsSL https://metabot-core.xvirobotics.com/install/install.sh | bash
```

Developer source checkout only:

```bash
metabot update --git
```

## Release Flow

1. Merge the feature MR into `main`.
2. On the release checkout, build and pack:

   ```bash
   npm run build
   ```

   The root build runs `pack-metabot.sh` and writes:

   ```text
   packages/server/static/install/install.sh
   packages/server/static/install/latest.tgz
   ```

3. For internal packages that need default env injection, build with:

   ```bash
   METABOT_PACKAGE_DEFAULT_ENV_FILE=/path/to/default.env npm run build
   ```

   The source env file must stay outside git. The packer embeds it as
   `.metabot-package/default.env`; the bootstrap installs it to
   `~/.metabot/default.env` with `chmod 600`.

4. Deploy metabot-core so `packages/server/static/install/` is rsynced to the
   production static directory.

5. Smoke test the endpoint:

   ```bash
   curl -I https://metabot-core.xvirobotics.com/install/install.sh
   curl -I https://metabot-core.xvirobotics.com/install/latest.tgz
   ```

6. Smoke test both host shapes:

   ```bash
   metabot update
   curl -fsSL https://metabot-core.xvirobotics.com/install/install.sh | METABOT_HOME=/tmp/metabot-smoke bash
   ```

## Package Contract

`latest.tgz` includes bot-host runtime code:

- `bin/`
- `install.sh`
- `ecosystem.config.cjs`
- root package manifests and tsconfigs
- `src/`
- `packages/cli`, `packages/cli-core`, `packages/metamemory`, `packages/skill-hub`
- `packages/skills`
- workspace prompt/docs needed by bot hosts

It intentionally excludes user state and central-only code:

- `.env`, `bots.json`, `logs/`, `data/`
- `.git`
- `node_modules`, `dist`, coverage and tsbuildinfo
- `packages/server`, `packages/web-ui`

## Announcement Checklist

After deploy, post:

- What changed
- Who should run `metabot update`
- Whether a restart happens
- Any new default env/config behavior
- The Meta Memory update doc link
