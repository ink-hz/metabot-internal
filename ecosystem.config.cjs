const path = require('path');

module.exports = {
  apps: [
    {
      name: 'metabot',
      script: 'src/index.ts',
      // Use `node --import tsx` instead of the tsx wrapper script.
      // The wrapper in node_modules/.bin/tsx is a POSIX shell script with no
      // .cmd shim, so PM2's child_process.spawn can't exec it on Windows
      // (EINVAL). `node --import tsx` is tsx 4.x's documented cross-platform
      // entrypoint and works identically on Linux/macOS/Windows.
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,

      // Watch disabled — use `metabot restart` to apply code changes manually
      watch: false,

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Logs
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Environment
      env: {
        NODE_ENV: 'production',
        CLAUDE_MAX_TURNS: '',  // unlimited turns (override any inherited shell env)
        // Hand `trunks` off to the metabot-pty dogfood app below. Excluding it
        // here frees its Feishu long-connection so the test app can hold it.
        METABOT_EXCLUDE_BOTS: 'trunks',
      },
    },

    // ── PTY-backend dogfood app ──────────────────────────────────────────
    // Runs ONLY `trunks` from the SAME working tree as production, but with
    // the PTY claude backend (set via bots.json `backend: "pty"`). Isolated
    // so it can never collide with production:
    //   - METABOT_ONLY_BOTS=trunks  → loads just the one bot (frees the rest)
    //   - API_PORT=9300             → separate API server (prod uses 9100)
    //   - SESSION_STORE_DIR         → separate sessions.db/activity.db AND
    //                                 scheduled-tasks.json (no shared-file race)
    //   - WIKI_SYNC_ENABLED=false   → no duplicate wiki push
    // To retire the experiment: `pm2 delete metabot-pty`, drop trunks from
    // METABOT_EXCLUDE_BOTS above, remove backend:"pty" from bots.json, restart.
    {
      name: 'metabot-pty',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      error_file: path.join(__dirname, 'logs', 'error-pty.log'),
      out_file: path.join(__dirname, 'logs', 'out-pty.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        CLAUDE_MAX_TURNS: '',
        METABOT_ONLY_BOTS: 'trunks',
        API_PORT: '9300',
        SESSION_STORE_DIR: path.join(require('os').homedir(), '.metabot-pty'),
        WIKI_SYNC_ENABLED: 'false',
      },
    },
  ],
};
