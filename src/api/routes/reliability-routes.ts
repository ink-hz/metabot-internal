import type * as http from 'node:http';

import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

const PROBE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function handleReliabilityRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'GET') return false;
  const parsed = new URL(url, 'http://localhost');
  const match = /^\/api\/reliability\/probes\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return false;

  const probeId = match[1];
  const attemptId = parsed.searchParams.get('attempt_id') ?? undefined;
  if (!PROBE_ID.test(probeId) || (attemptId && !PROBE_ID.test(attemptId))) {
    jsonResponse(res, 400, { error: 'Invalid probe identifier' });
    return true;
  }

  const receipt = attemptId
    ? ctx.probeReceiptStore.getAttempt(probeId, attemptId)
    : ctx.probeReceiptStore.get(probeId);
  if (!receipt) {
    jsonResponse(res, 404, { error: 'Probe receipt not found' });
    return true;
  }
  jsonResponse(res, 200, receipt);
  return true;
}
