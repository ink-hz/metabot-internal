import { describe, expect, it } from 'vitest';
import { claudeProjectDirectoryName } from '../src/engines/claude/pty/pty-session.js';

describe('Claude project JSONL directory encoding', () => {
  it('matches Claude Code encoding for dotted worktree path components', () => {
    expect(claudeProjectDirectoryName(
      '/Users/neo/Developer/work/metabot-dev/.worktrees/opus-gateway-compat',
    )).toBe('-Users-neo-Developer-work-metabot-dev--worktrees-opus-gateway-compat');
  });

  it('keeps ordinary production paths stable', () => {
    expect(claudeProjectDirectoryName('/Users/agentops/AgentRuntime/metabot'))
      .toBe('-Users-agentops-AgentRuntime-metabot');
  });
});
