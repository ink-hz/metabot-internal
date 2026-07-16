import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractCompletedAssistantText,
  readCompletedAssistantTextSince,
  resolveUnexpectedExit,
} from '../src/engines/claude/pty/turn-recovery.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    parentToolUseID: null,
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Live search is currently unavailable.' }],
    },
    ...overrides,
  };
}

describe('PTY completed-turn recovery', () => {
  it('accepts only top-level end_turn assistant text', () => {
    expect(extractCompletedAssistantText(assistant())).toBe('Live search is currently unavailable.');
    expect(extractCompletedAssistantText(assistant({
      message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'partial' }] },
    }))).toBeNull();
    expect(extractCompletedAssistantText(assistant({ parentToolUseID: 'subagent-1' }))).toBeNull();
    expect(extractCompletedAssistantText(assistant({ parent_tool_use_id: 'subagent-2' }))).toBeNull();
    expect(extractCompletedAssistantText(assistant({
      message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }] },
    }))).toBeNull();
    expect(extractCompletedAssistantText(assistant({
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '  ' }] },
    }))).toBeNull();
    expect(extractCompletedAssistantText(assistant({
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      },
    }))).toBe('first\nsecond');
  });

  it('reads only completed text written after the current turn offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-turn-recovery-'));
    tempDirs.push(dir);
    const path = join(dir, 'session.jsonl');
    const previous = `${JSON.stringify(assistant({
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'previous answer' }] },
    }))}\n`;
    writeFileSync(path, previous);
    const offset = Buffer.byteLength(previous);
    const current = JSON.stringify(assistant({
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'current answer' }] },
    }));
    writeFileSync(path, previous + current);

    expect(readCompletedAssistantTextSince(path, offset)).toBe('current answer');
    expect(readCompletedAssistantTextSince(path, offset + Buffer.byteLength(current))).toBeNull();
  });

  it('does not recover a tool-use or partial current turn from the prior answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-turn-recovery-'));
    tempDirs.push(dir);
    const path = join(dir, 'session.jsonl');
    const previous = `${JSON.stringify(assistant())}\n`;
    writeFileSync(path, previous + JSON.stringify(assistant({
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: {} }],
      },
    })));

    expect(readCompletedAssistantTextSince(path, Buffer.byteLength(previous))).toBeNull();
  });

  it('maps completed text to success and leaves an incomplete turn for typed crash propagation', () => {
    expect(resolveUnexpectedExit('Provider search is unavailable.')).toEqual({
      kind: 'completed',
      resultText: 'Provider search is unavailable.',
    });
    expect(resolveUnexpectedExit(null)).toEqual({ kind: 'incomplete' });
  });
});
