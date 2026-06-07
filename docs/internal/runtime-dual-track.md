# Bridge Runtime Dual Track

MetaBot production remains a Node runtime by default. The PM2 app in
`ecosystem.config.cjs` launches `src/index.ts` as:

```bash
node --import tsx src/index.ts
```

This is the supported production path until Bun has been verified against the
bridge's native and process-control surfaces.

## Optional Bun Path

For local assessment only:

```bash
npm run dev:bun
```

This runs:

```bash
bun run src/index.ts
```

Do not point PM2 production at Bun until the smoke list below passes in an
isolated bot/API port.

## Runtime Surfaces To Verify

- Native dependencies: `better-sqlite3`, `node-pty`.
- Process spawning: Claude, Codex, Kimi, `ffmpeg`, and `lark-cli` commands use
  `node:child_process` or `node-pty`.
- File watching: Agent Teams `bots.json` hot reload uses `fs.watch`.
- Startup: `src/index.ts` opens IM long connections, starts API routes, starts
  schedulers/supervisor, and initializes SQLite-backed stores.
- PM2 lifecycle: production restart, autorestart, logs, and health checks must
  keep working with Node as the default.

## Health Metadata

`GET /api/health` now includes `runtime`:

- `activeRuntime`: `node` or `bun`.
- `productionDefaultRuntime`: always `node`.
- `pm2Launch`: current supported PM2 launch path.
- `bunOptInLaunch`: local Bun assessment command.
- `bunVerified`: true only when the running bridge process itself is Bun.
- `nativeDependencies`: native modules that must be included in Bun smoke.

## Minimum Bun Smoke

1. Install Bun in the target runtime host.
2. Start an isolated instance with a separate `API_PORT`, `METABOT_ONLY_BOTS`,
   and non-production bot binding.
3. Confirm `/api/health.runtime.activeRuntime == "bun"` and `bunVerified == true`.
4. Exercise `better-sqlite3` stores: sessions, activity, Agent Teams, and sync.
5. Exercise `node-pty` Claude PTY backend or explicitly disable PTY for the test.
6. Exercise Codex/Claude/Kimi child-process spawning and cancellation.
7. Edit `bots.json` and confirm Agent Teams hot reload still fires.
8. Stop the isolated instance and confirm production PM2 Node bridge is unchanged.
