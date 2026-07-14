import { describe, expect, it } from 'vitest';

import {
  classifySyntheticProbe,
  loadSyntheticAllowlist,
} from '../src/reliability/synthetic-context.js';

const probeId = '01J2Z9K2E8F5G9M6W4Q3T7R8Y1';
const attemptId = '01J2Z9M77A68K8B1T4W5F6H9P0';
const marker = `[metabot-probe id=${probeId} attempt=${attemptId}]`;
const allowlist = {
  unionIds: new Set(['on_test']),
  chatIds: new Set(['oc_canary']),
};

describe('classifySyntheticProbe', () => {
  it('accepts a strict marker only from the controlled identity and chat', () => {
    expect(classifySyntheticProbe({
      unionId: 'on_test',
      chatId: 'oc_canary',
      text: `${marker} ping`,
    }, allowlist)).toEqual({ isSynthetic: true, probeId, attemptId });
  });

  it('does not trust a marker from a real user or a non-canary chat', () => {
    expect(classifySyntheticProbe({
      unionId: 'on_real', chatId: 'oc_canary', text: marker,
    }, allowlist)).toBeUndefined();
    expect(classifySyntheticProbe({
      unionId: 'on_test', chatId: 'oc_real', text: marker,
    }, allowlist)).toBeUndefined();
  });

  it('does not classify allowlisted traffic without an exact marker', () => {
    expect(classifySyntheticProbe({
      unionId: 'on_test', chatId: 'oc_canary', text: 'hello',
    }, allowlist)).toBeUndefined();
    expect(classifySyntheticProbe({
      unionId: 'on_test', chatId: 'oc_canary', text: `${marker}suffix`,
    }, allowlist)).toBeUndefined();
  });

  it('supports a controlled PDF file message without trusting arbitrary filenames', () => {
    expect(classifySyntheticProbe({
      unionId: 'on_test',
      chatId: 'oc_canary',
      text: '请分析这个文件',
      fileName: `metabot-probe-${probeId}-${attemptId}.pdf`,
    }, allowlist)).toEqual({ isSynthetic: true, probeId, attemptId });
    expect(classifySyntheticProbe({
      unionId: 'on_test',
      chatId: 'oc_canary',
      text: '请分析这个文件',
      fileName: `report-${probeId}.pdf`,
    }, allowlist)).toBeUndefined();
  });
});

describe('loadSyntheticAllowlist', () => {
  it('trims comma-separated identifiers and drops empty entries', () => {
    const loaded = loadSyntheticAllowlist({
      METABOT_SYNTHETIC_UNION_IDS: ' on_test, on_second, ',
      METABOT_SYNTHETIC_CHAT_IDS: 'oc_canary,,oc_second',
    });
    expect([...loaded.unionIds]).toEqual(['on_test', 'on_second']);
    expect([...loaded.chatIds]).toEqual(['oc_canary', 'oc_second']);
  });
});
