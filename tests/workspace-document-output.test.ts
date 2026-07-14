import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const promptFiles = ['CLAUDE.md', 'src/workspace/CLAUDE.md'];

describe.each(promptFiles)('%s document output contract', (relativePath) => {
  const prompt = fs.readFileSync(path.join(root, relativePath), 'utf8');

  it('honours requested formats and sends files through the outputs directory', () => {
    expect(prompt).toContain('user requests a specific format');
    expect(prompt).toContain('outputs directory provided in the system prompt');
    expect(prompt).toContain('readable, topic-specific filename');
  });

  it('documents the production docx and PDF recipes', () => {
    expect(prompt).toContain('pandoc input.md -o output.docx');
    expect(prompt).toContain('pandoc input.md -o output.pdf --pdf-engine=typst');
  });

  it('keeps text answers available and reserves lark-doc for explicit cloud requests', () => {
    expect(prompt).toContain('must not suppress the text answer');
    expect(prompt).toContain('explicitly asks for a Feishu cloud document');
  });
});
