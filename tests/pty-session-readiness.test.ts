import { describe, expect, it } from 'vitest';
import { isClaudeIdleInputScreen } from '../src/engines/claude/pty/pty-session.js';

describe('Claude PTY readiness', () => {
  it('accepts only the current idle input screen', () => {
    expect(isClaudeIdleInputScreen([
      'Claude Code v2.1.207',
      '────────────────────────',
      '❯ ',
      '────────────────────────',
      'bypass permissions on (shift+tab to cycle) · high · /effort',
    ].join('\n'))).toBe(true);
  });

  it('rejects an active turn and blocking startup menus', () => {
    expect(isClaudeIdleInputScreen([
      '❯ Reply only: OK',
      'bypass permissions on · esc to interrupt · high',
    ].join('\n'))).toBe(false);

    expect(isClaudeIdleInputScreen([
      'Is this a project you trust?',
      '❯ 1. Yes',
      '  2. No',
      'Enter to select · Esc to cancel',
    ].join('\n'))).toBe(false);

    expect(isClaudeIdleInputScreen([
      'Permission required',
      '❯ 1. Allow once',
      'Shift+Tab to approve',
    ].join('\n'))).toBe(false);
  });

  it('does not accept stale append-log output whose latest frame is a menu', () => {
    expect(isClaudeIdleInputScreen([
      '❯ ',
      'bypass permissions on (shift+tab to cycle)',
      'Is this a project you trust?',
      '❯ 1. Yes',
      'Enter to select · Esc to cancel',
    ].join('\n'))).toBe(false);
  });
});
