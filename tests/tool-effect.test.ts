import { describe, expect, it } from 'vitest';
import { classifyToolEffect, strongestToolEffect } from '../src/bridge/tool-effect.js';

describe('tool effect classification', () => {
  it('allows only explicit read-only tools and conservative shell inspection', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch']) {
      expect(classifyToolEffect(name, {})).toBe('read_only');
    }
    for (const command of [
      'pwd',
      'ls -la /tmp',
      'command -v pandoc',
      'rg -n timeout src tests',
      'git status --short',
      'git diff -- src/index.ts',
      'pandoc --version',
    ]) {
      expect(classifyToolEffect('Bash', { command })).toBe('read_only');
    }
  });

  it('blocks replay for local writes, shell mutations, control operators, and unknown tools', () => {
    expect(classifyToolEffect('Write', { file_path: '/tmp/out.md' })).toBe('local_idempotent');
    expect(classifyToolEffect('Edit', { file_path: '/tmp/out.md' })).toBe('local_idempotent');
    for (const command of [
      'rm report.md',
      'pandoc input.md -o output.pptx',
      'rg timeout src | head',
      'ls > listing.txt',
      'ls>listing.txt',
      'echo $(printenv SECRET)',
      'git status; git push',
      'git status&&git push',
    ]) {
      expect(classifyToolEffect('Bash', { command })).toBe('external_side_effect');
    }
    expect(classifyToolEffect('SendMessage', {})).toBe('external_side_effect');
    expect(classifyToolEffect('FutureUnknownTool', {})).toBe('external_side_effect');
  });

  it('keeps the strongest observed effect', () => {
    expect(strongestToolEffect('read_only', 'local_idempotent')).toBe('local_idempotent');
    expect(strongestToolEffect('local_idempotent', 'external_side_effect'))
      .toBe('external_side_effect');
  });
});
