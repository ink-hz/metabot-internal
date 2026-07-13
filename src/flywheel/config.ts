import { readFileSync } from 'node:fs';

export interface FlywheelConfig {
  enabled: boolean;
  databaseUrl?: string;
  queueCapacity: number;
  batchSize: number;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
}

export function loadFlywheelConfig(env: NodeJS.ProcessEnv = process.env): FlywheelConfig {
  const enabled = isFlywheelEnabled(env);
  const defaults = { enabled, queueCapacity: 2000, batchSize: 50, timeoutMs: 2000, maxAttempts: 3, retryBaseMs: 100 };
  if (!enabled) return defaults;

  const fileEnv = readEnvFile(env.FLYWHEEL_ENV_FILE ?? '/Users/agentops/.metabot/flywheel.env');
  const combined = { ...fileEnv, ...env };
  return {
    enabled,
    databaseUrl: combined.FLYWHEEL_DATABASE_URL,
    queueCapacity: positiveInt(combined.FLYWHEEL_QUEUE_CAPACITY, defaults.queueCapacity),
    batchSize: positiveInt(combined.FLYWHEEL_BATCH_SIZE, defaults.batchSize),
    timeoutMs: positiveInt(combined.FLYWHEEL_TIMEOUT_MS, defaults.timeoutMs),
    maxAttempts: positiveInt(combined.FLYWHEEL_MAX_ATTEMPTS, defaults.maxAttempts),
    retryBaseMs: positiveInt(combined.FLYWHEEL_RETRY_BASE_MS, defaults.retryBaseMs),
  };
}

export function isFlywheelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.FLYWHEEL_ENABLED ?? '');
}

function readEnvFile(path: string): NodeJS.ProcessEnv {
  try {
    const parsed: NodeJS.ProcessEnv = {};
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const equals = line.indexOf('=');
      if (equals < 1) continue;
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      parsed[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
