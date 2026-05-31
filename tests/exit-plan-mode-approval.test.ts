import { describe, it, expect, vi } from 'vitest';
import { isKeepPlanning } from '../src/engines/claude/persistent-executor.js';
import { driveInteractiveTool } from '../src/engines/claude/pty/interactive-driver.js';
import type {
  PtyClaudeSession,
  PtyInteractiveResponse,
  PtyInteractiveTool,
} from '../src/engines/claude/pty/contract.js';

/**
 * ExitPlanMode now asks the user (Proceed / Keep planning) instead of silently
 * auto-proceeding. Two pieces under test:
 *   1. isKeepPlanning — maps the user's answer to proceed vs stay-in-plan.
 *   2. the driver — Esc on keep-planning, the menu's bypass digit on approve.
 */

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;

describe('isKeepPlanning', () => {
  it('proceeds on empty (timeout) — preserves auto-approve', () => {
    expect(isKeepPlanning('')).toBe(false);
    expect(isKeepPlanning('   ')).toBe(false);
  });

  it('proceeds on explicit proceed/yes-style answers (case-insensitive)', () => {
    for (const a of ['Proceed', 'proceed', 'YES', 'y', 'approve', 'OK', 'do it']) {
      expect(isKeepPlanning(a), a).toBe(false);
    }
  });

  it('keeps planning on "Keep planning", "no", or free-text feedback', () => {
    for (const a of ['Keep planning', 'no', 'revise the auth bit', 'use redis instead']) {
      expect(isKeepPlanning(a), a).toBe(true);
    }
  });
});

function fakeSession(snapshot: string): { session: PtyClaudeSession; keys: string[] } {
  const keys: string[] = [];
  const session = {
    sessionId: 's',
    jsonlPath: '/tmp/s.jsonl',
    ready: async () => {},
    typePrompt: async () => {},
    sendKeys: (d: string) => { keys.push(d); },
    snapshot: () => snapshot,
    interrupt: async () => {},
    dispose: async () => {},
  } as PtyClaudeSession;
  return { session, keys };
}

const exitPlanTool: PtyInteractiveTool = { name: 'ExitPlanMode', toolUseId: 't1', input: { plan: 'p' } };

describe('driveInteractiveTool — ExitPlanMode', () => {
  it('sends Esc to keep planning on a cancel response', async () => {
    const { session, keys } = fakeSession('');
    const response: PtyInteractiveResponse = { kind: 'cancel' };
    await driveInteractiveTool({ session, tool: exitPlanTool, response, logger });
    expect(keys).toEqual(['\x1b']);
  });

  it('presses the bypass-permissions digit to proceed on approve', async () => {
    // Menu rendered with the proceed option as digit 2.
    const menu = [
      'Would you like to proceed?',
      '1. Yes',
      '2. Yes, and bypass permissions',
      '3. No, keep planning',
    ].join('\n');
    const { session, keys } = fakeSession(menu);
    const response: PtyInteractiveResponse = { kind: 'approve' };
    await driveInteractiveTool({ session, tool: exitPlanTool, response, logger });
    expect(keys).toEqual(['2']);
  });
});
