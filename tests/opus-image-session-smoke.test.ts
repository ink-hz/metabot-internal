import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertSmokeEvidence,
  createMarkerPdf,
  extractUserImageHashes,
  type SmokeEvidence,
} from '../scripts/smoke-opus-image-session.js';

const hash = (data: string): string =>
  `image/png:${createHash('sha256').update(data).digest('hex')}`;

function passingEvidence(): SmokeEvidence {
  return {
    profileId: 'nexcor-opus-4-8-claude-code-2.1.207',
    model: 'claude-opus-4-8',
    sessionId: 'session-1',
    imageTurns: [
      { answer: 'Metabot', cacheReadTokens: 0, readToolUses: 1, errors: [] },
      { answer: '17:17', cacheReadTokens: 12, readToolUses: 1, errors: [] },
      { answer: 'Metabot', cacheReadTokens: 24, readToolUses: 1, errors: [] },
    ],
    pdfTurn: {
      answer: 'ORBBEC-7429',
      cacheReadTokens: 30,
      readToolUses: 1,
      errors: [],
    },
    historicalImageHashes: [hash('demo-1'), hash('demo-2'), hash('demo-1')],
  };
}

describe('Opus persistent image session smoke', () => {
  it('accepts exact ordered image answers, cache reuse, PDF marker, and history hashes', () => {
    expect(() => assertSmokeEvidence(passingEvidence())).not.toThrow();
  });

  it('rejects a content-block error even when answers otherwise match', () => {
    const evidence = passingEvidence();
    evidence.imageTurns[1].errors.push('Content block not found');
    expect(() => assertSmokeEvidence(evidence)).toThrow(/content block/i);
  });

  it('rejects missing cache reads by the third image turn', () => {
    const evidence = passingEvidence();
    evidence.imageTurns[1].cacheReadTokens = 0;
    evidence.imageTurns[2].cacheReadTokens = 0;
    expect(() => assertSmokeEvidence(evidence)).toThrow(/cache read/i);
  });

  it('rejects reordered or duplicated persistent image history', () => {
    const reordered = passingEvidence();
    reordered.historicalImageHashes = [hash('demo-1'), hash('demo-2'), hash('demo-2')];
    expect(() => assertSmokeEvidence(reordered)).toThrow(/history/i);

    const duplicated = passingEvidence();
    duplicated.historicalImageHashes = [hash('demo-1'), hash('demo-1'), hash('demo-1')];
    expect(() => assertSmokeEvidence(duplicated)).toThrow(/history/i);
  });

  it('extracts one image hash from each user tool-result record in order', () => {
    const line = (data: string) => JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data },
          }],
        }],
      },
    });
    const ignoredAssistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ignored' } }] },
    });

    expect(extractUserImageHashes([
      line('demo-1'),
      ignoredAssistant,
      line('demo-2'),
      line('demo-1'),
    ].join('\n'))).toEqual([hash('demo-1'), hash('demo-2'), hash('demo-1')]);
  });

  it('generates a valid marker PDF without external conversion tools', () => {
    const pdf = createMarkerPdf('ORBBEC-7429');
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdf.toString('ascii')).toContain('(ORBBEC-7429) Tj');
    expect(pdf.toString('ascii')).toContain('startxref');
  });
});
