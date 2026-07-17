import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production PTY smoke contract', () => {
  it('uses the production Opus model with the 200k context guard', () => {
    const source = readFileSync(new URL('../scripts/smoke-pty.ts', import.meta.url), 'utf8');

    expect(source).toContain("model: 'claude-opus-4-8'");
    expect(source).toContain("CLAUDE_CODE_DISABLE_1M_CONTEXT: '1'");
    expect(source).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000'");
    expect(source).toContain('loadClaudeCompatibilityProfile');
    expect(source).toContain('startClaudeCompatibilityRuntime');
    expect(source).toContain('applyClaudeCompatibilityRuntime');
    expect(source).toContain('settingsEnv: compatibilityRuntime.settingsEnv');
    expect(source).not.toContain("model: 'fable'");
    expect(source).toContain("message.type === 'assistant'");
    expect(source).toContain("message.subtype === 'success'");
    expect(source).not.toContain('transcript.includes(marker)');
  });

  it('uses a hard deadline that cannot wait forever on cleanup', () => {
    const source = readFileSync(new URL('../scripts/smoke-pty.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('setTimeout(async () =>');
    expect(source).toMatch(/setTimeout\(\(\) => \{[\s\S]*process\.exit\(2\);[\s\S]*\}, 60_000\)/u);
  });

  it('terminates successfully after emitting the exact marker', () => {
    const source = readFileSync(new URL('../scripts/smoke-pty.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/console\.log\(marker\);\s*process\.exit\(0\);/u);
  });
});
