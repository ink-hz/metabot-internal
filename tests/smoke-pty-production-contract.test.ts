import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production PTY smoke contract', () => {
  it('uses the production Opus model with the 200k context guard', () => {
    const source = readFileSync(new URL('../scripts/smoke-pty.ts', import.meta.url), 'utf8');

    expect(source).toContain("model: 'claude-opus-4-8'");
    expect(source).toContain("CLAUDE_CODE_DISABLE_1M_CONTEXT: '1'");
    expect(source).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000'");
    expect(source).not.toContain("model: 'fable'");
    expect(source).toContain("message.type === 'assistant'");
    expect(source).toContain("message.subtype === 'success'");
    expect(source).not.toContain('transcript.includes(marker)');
  });
});
