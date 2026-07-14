import type {
  ProbeStageReceipt,
  SyntheticProbeContext,
} from './probe-types.js';

const ALLOWED_RECEIPT_FIELDS = new Set([
  'stage',
  'at',
  'botName',
  'messageId',
  'fileKey',
  'fileName',
  'sessionId',
  'model',
  'backend',
  'errorClass',
]);

export interface ProbeAttemptReceipt {
  probeId: string;
  attemptId: string;
  stages: ProbeStageReceipt[];
}

export interface ProbeReceipt {
  probeId: string;
  attempts: ProbeAttemptReceipt[];
}

interface StoredProbe {
  expiresAt: number;
  attempts: Map<string, ProbeAttemptReceipt>;
}

export class ProbeReceiptStore {
  private readonly rows = new Map<string, StoredProbe>();

  constructor(
    private readonly options = {
      ttlMs: 48 * 60 * 60 * 1000,
      maxProbes: 1000,
    },
  ) {}

  record(
    probe: SyntheticProbeContext,
    receipt: ProbeStageReceipt,
  ): void {
    for (const key of Object.keys(receipt)) {
      if (!ALLOWED_RECEIPT_FIELDS.has(key)) {
        throw new Error(`unsupported receipt field: ${key}`);
      }
    }

    this.prune();
    const stored = this.rows.get(probe.probeId) ?? {
      expiresAt: Date.now() + this.options.ttlMs,
      attempts: new Map<string, ProbeAttemptReceipt>(),
    };
    stored.expiresAt = Date.now() + this.options.ttlMs;
    const attempt = stored.attempts.get(probe.attemptId) ?? {
      probeId: probe.probeId,
      attemptId: probe.attemptId,
      stages: [],
    };
    attempt.stages.push(Object.freeze({ ...receipt }));
    stored.attempts.set(probe.attemptId, attempt);

    this.rows.delete(probe.probeId);
    this.rows.set(probe.probeId, stored);
    while (this.rows.size > this.options.maxProbes) {
      const oldest = this.rows.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }

  get(probeId: string): ProbeReceipt | undefined {
    this.prune();
    const stored = this.rows.get(probeId);
    if (!stored) return undefined;
    return structuredClone({
      probeId,
      attempts: Array.from(stored.attempts.values()),
    });
  }

  getAttempt(
    probeId: string,
    attemptId: string,
  ): ProbeAttemptReceipt | undefined {
    this.prune();
    const attempt = this.rows.get(probeId)?.attempts.get(attemptId);
    return attempt ? structuredClone(attempt) : undefined;
  }

  private prune(): void {
    const now = Date.now();
    for (const [probeId, stored] of this.rows) {
      if (stored.expiresAt <= now) this.rows.delete(probeId);
    }
  }
}
