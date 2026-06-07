#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('usage: node scripts/run-bun-if-available.mjs <bun-arg> ...');
  process.exit(2);
}

const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (probe.error?.code === 'ENOENT') {
  console.error('error: Bun is not installed on PATH.');
  console.error('Bun migration scripts are opt-in experiments; npm/Node remain the release defaults.');
  console.error('Install Bun, then retry this command. Production PM2 should still use Node.');
  process.exit(127);
}
if (probe.status !== 0) {
  process.stderr.write(probe.stderr || probe.stdout || 'error: failed to run bun --version\n');
  process.exit(probe.status ?? 1);
}

const result = spawnSync('bun', args, { stdio: 'inherit' });
if (result.error) {
  console.error(`error: failed to execute bun: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
