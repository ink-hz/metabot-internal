#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checks = [
  {
    name: 'install',
    path: 'packages/server/static/install/latest.tgz',
    minBytes: 1024,
    listingMarkers: [
      'src/agent-teams/',
      'src/skills/metabot-team/SKILL.md',
      'packages/cli/src/teams.ts',
      'bin/metabot',
    ],
    contentMarkers: [
      'metabot teams',
      'MetaBot Agent Teams',
      'agents delete',
      'runs stop',
      '/api/agent-teams',
    ],
  },
  {
    name: 'cli',
    path: 'packages/server/static/cli/latest.tgz',
    minBytes: 1024,
    listingMarkers: ['package/bundle.mjs', 'package/skills/metabot/SKILL.md'],
    contentMarkers: [
      'metabot teams',
      'MetaBot Agent Teams',
      'agents delete',
      'runs stop',
      '/api/agent-teams',
    ],
  },
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function tarList(artifactPath) {
  return execFileSync('tar', ['tzf', artifactPath], { encoding: 'utf8' });
}

function tarExtractAll(artifactPath) {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-pack-verify-'));
  execFileSync('tar', ['xzf', artifactPath, '-C', dir], { stdio: 'pipe' });
  return dir;
}

function readTreeText(dir) {
  const out = execFileSync('find', [dir, '-maxdepth', '8', '-type', 'f', '-print0']);
  const paths = out.toString('utf8').split('\0').filter(Boolean);
  let text = '';
  for (const filePath of paths) {
    try {
      text += readFileSync(filePath, 'utf8');
      text += '\n';
    } catch {
      // Binary files are irrelevant for marker checks.
    }
  }
  return text;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

for (const check of checks) {
  if (!existsSync(check.path)) {
    fail(`${check.name} artifact missing: ${check.path}`);
    continue;
  }

  const size = statSync(check.path).size;
  const digest = sha256(check.path);
  if (size < check.minBytes) {
    fail(`${check.name} artifact too small: ${size} bytes`);
  }

  const listing = tarList(check.path);
  for (const marker of check.listingMarkers) {
    if (!listing.includes(marker)) {
      fail(`${check.name} artifact missing listing marker: ${marker}`);
    }
  }

  const dir = tarExtractAll(check.path);
  try {
    const text = readTreeText(dir);
    for (const marker of check.contentMarkers) {
      if (!text.includes(marker)) {
        fail(`${check.name} artifact missing content marker: ${marker}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`ok: ${check.name} artifact ${check.path} (${size} bytes, sha256 ${digest})`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
