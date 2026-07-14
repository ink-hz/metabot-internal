import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { RawJsonlRecord } from './contract.js';

const MAX_RECOVERY_TAIL_BYTES = 4 * 1024 * 1024;
const EXIT_ERROR_TEXT = 'claude process exited before the turn completed';

export function extractCompletedAssistantText(record: RawJsonlRecord): string | null {
  if (record.type !== 'assistant') return null;
  if (record.parentToolUseID != null || record.parent_tool_use_id != null) return null;
  const message = record.message as Record<string, unknown> | undefined;
  if (message?.stop_reason !== 'end_turn' || !Array.isArray(message.content)) return null;

  const texts: string[] = [];
  for (const value of message.content) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      texts.push(block.text.trim());
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

export function readCompletedAssistantTextSince(
  jsonlPath: string,
  turnStartOffset: number,
  maxTailBytes = MAX_RECOVERY_TAIL_BYTES,
): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(jsonlPath).size;
    const boundedOffset = size < turnStartOffset ? 0 : Math.max(0, turnStartOffset);
    if (size <= boundedOffset) return null;
    const start = Math.max(boundedOffset, size - maxTailBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fd = openSync(jsonlPath, 'r');
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const text = extractCompletedAssistantText(JSON.parse(line) as RawJsonlRecord);
        if (text) return text;
      } catch {
        // A tail can begin in the middle of a large record. Only complete JSONL
        // assistant records are eligible for recovery.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort recovery read */ }
    }
  }
}

export function resolveUnexpectedExit(completedText: string | null | undefined): {
  isError: boolean;
  resultText: string;
} {
  const text = completedText?.trim();
  return text
    ? { isError: false, resultText: text }
    : { isError: true, resultText: EXIT_ERROR_TEXT };
}
