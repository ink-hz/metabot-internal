import type { SyntheticProbeContext } from './probe-types.js';

const PROBE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export function parseInternalProbe(
  value: unknown,
): SyntheticProbeContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'attemptId,probeId') {
    return undefined;
  }
  if (typeof row.probeId !== 'string' || typeof row.attemptId !== 'string') {
    return undefined;
  }
  if (!PROBE_ID.test(row.probeId) || !PROBE_ID.test(row.attemptId)) {
    return undefined;
  }
  return {
    isSynthetic: true,
    probeId: row.probeId,
    attemptId: row.attemptId,
  };
}
