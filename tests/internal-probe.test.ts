import { describe, expect, it } from 'vitest';

import { parseInternalProbe } from '../src/reliability/internal-probe.js';

const PROBE_ID = '01J2Z9K2E8F5G9M6W4Q3T7R8Y1';
const ATTEMPT_ID = '01J2Z9M77A68K8B1T4W5F6H9P0';

describe('parseInternalProbe', () => {
  it('accepts only an exact pair of valid opaque identifiers', () => {
    expect(parseInternalProbe({
      probeId: PROBE_ID,
      attemptId: ATTEMPT_ID,
    })).toEqual({
      isSynthetic: true,
      probeId: PROBE_ID,
      attemptId: ATTEMPT_ID,
    });
  });

  it.each([
    undefined,
    null,
    [],
    { probeId: 'bad', attemptId: ATTEMPT_ID },
    { probeId: PROBE_ID, attemptId: 'bad' },
    { probeId: PROBE_ID, attemptId: ATTEMPT_ID, content: 'secret' },
  ])('rejects malformed or content-bearing values', (value) => {
    expect(parseInternalProbe(value)).toBeUndefined();
  });
});
