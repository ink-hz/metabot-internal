import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_REQUIRED_LIFETIME_MS = 600_000;
const HEARTBEAT_CONTRACT_MS = 60_000;

export interface ProviderStreamLifetimeEvidence {
  requiredLifetimeMs: number;
  observedDurationMs: number;
  maxIdleGapMs: number;
  endedEarly: boolean;
}

export interface ProviderStreamLifetimeEvaluation extends ProviderStreamLifetimeEvidence {
  passed: boolean;
  heartbeatWithinContract: boolean;
}

export function evaluateProviderStreamLifetime(
  evidence: ProviderStreamLifetimeEvidence,
): ProviderStreamLifetimeEvaluation {
  return {
    ...evidence,
    passed: !evidence.endedEarly
      && evidence.observedDurationMs >= evidence.requiredLifetimeMs,
    heartbeatWithinContract: evidence.maxIdleGapMs <= HEARTBEAT_CONTRACT_MS,
  };
}

export function buildProviderStreamDryRunReport() {
  return {
    mode: 'dry-run' as const,
    requiredLifetimeMs: DEFAULT_REQUIRED_LIFETIME_MS,
    heartbeatContractMs: HEARTBEAT_CONTRACT_MS,
    mutatesSettings: false,
    eligibleToRaiseTimeout: false,
  };
}

async function probeProviderStream(args: {
  url: string;
  authToken: string;
  requiredLifetimeMs?: number;
}): Promise<ProviderStreamLifetimeEvaluation> {
  const requiredLifetimeMs = args.requiredLifetimeMs ?? DEFAULT_REQUIRED_LIFETIME_MS;
  const startedAt = Date.now();
  let lastChunkAt = startedAt;
  let maxIdleGapMs = 0;
  const response = await fetch(args.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.authToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ probe: 'metabot-provider-stream-lifetime' }),
  });
  if (!response.ok || !response.body) {
    return evaluateProviderStreamLifetime({
      requiredLifetimeMs,
      observedDurationMs: Date.now() - startedAt,
      maxIdleGapMs: Date.now() - lastChunkAt,
      endedEarly: true,
    });
  }

  const reader = response.body.getReader();
  let endedEarly = false;
  while (Date.now() - startedAt < requiredLifetimeMs) {
    const remainingMs = requiredLifetimeMs - (Date.now() - startedAt);
    const outcome = await new Promise<
      { kind: 'read'; value: ReadableStreamReadResult<Uint8Array> } | { kind: 'lifetime' }
    >((resolveOutcome, rejectOutcome) => {
      const timer = setTimeout(() => resolveOutcome({ kind: 'lifetime' }), remainingMs);
      reader.read().then(
        (value) => {
          clearTimeout(timer);
          resolveOutcome({ kind: 'read', value });
        },
        (error) => {
          clearTimeout(timer);
          rejectOutcome(error);
        },
      );
    });
    if (outcome.kind === 'lifetime') {
      await reader.cancel();
      break;
    }
    const now = Date.now();
    maxIdleGapMs = Math.max(maxIdleGapMs, now - lastChunkAt);
    lastChunkAt = now;
    if (outcome.value.done) {
      endedEarly = now - startedAt < requiredLifetimeMs;
      break;
    }
  }

  const observedDurationMs = Date.now() - startedAt;
  maxIdleGapMs = Math.max(maxIdleGapMs, Date.now() - lastChunkAt);
  return evaluateProviderStreamLifetime({
    requiredLifetimeMs,
    observedDurationMs,
    maxIdleGapMs,
    endedEarly,
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(buildProviderStreamDryRunReport(), null, 2));
    return;
  }
  const url = process.env.PROVIDER_STREAM_PROBE_URL?.trim();
  const authToken = process.env.PROVIDER_STREAM_PROBE_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error(
      'Set PROVIDER_STREAM_PROBE_URL and PROVIDER_STREAM_PROBE_TOKEN, or use --dry-run',
    );
  }
  const evidence = await probeProviderStream({ url, authToken });
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Provider stream probe failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
