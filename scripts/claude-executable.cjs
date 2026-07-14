const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveClaudeExecutable(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? fs.existsSync;
  const explicit = env.CLAUDE_EXECUTABLE_PATH?.trim();

  if (explicit) return explicit;

  const candidates = [
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  return candidates.find((candidate) => exists(candidate));
}

module.exports = { resolveClaudeExecutable };
