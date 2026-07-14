import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('PM2 Claude executable configuration', () => {
  it('resolves an explicit executable before installation candidates', () => {
    const { resolveClaudeExecutable } = require('../scripts/claude-executable.cjs');

    expect(resolveClaudeExecutable({
      env: { CLAUDE_EXECUTABLE_PATH: '/opt/claude/bin/claude' },
      home: '/Users/agentops',
      exists: () => false,
    })).toBe('/opt/claude/bin/claude');
  });

  it('discovers the agentops npm-global installation without relying on PATH', () => {
    const { resolveClaudeExecutable } = require('../scripts/claude-executable.cjs');
    const existing = new Set(['/Users/agentops/.npm-global/bin/claude']);

    expect(resolveClaudeExecutable({
      env: {},
      home: '/Users/agentops',
      exists: (candidate: string) => existing.has(candidate),
    })).toBe('/Users/agentops/.npm-global/bin/claude');
  });

  it('pins a discovered Claude executable in the PM2 environment', () => {
    const ecosystem = require('../ecosystem.config.cjs');

    expect(ecosystem.apps[0].env.CLAUDE_EXECUTABLE_PATH).toMatch(/\/claude$/);
  });
});
