import { createHash } from 'node:crypto';
import type {
  CapabilityDeclaration,
  CapabilityState,
} from '../engines/claude/compatibility/profile.js';

export type WsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface WsConnectionSnapshot {
  state: WsConnectionState;
  reconnectAttempts: number;
  lastConnectTime?: number;
  nextConnectTime?: number;
}

export interface BotRuntimeSource {
  name: string;
  platform: string;
  engine: string;
  model?: string;
  backend: string;
  workdirFingerprint?: string;
  capabilities?: readonly CapabilityDeclaration[];
  connectionStatus?: () => WsConnectionSnapshot;
  activeTurns?: () => number;
}

export interface RuntimeCapability {
  name: string;
  state: CapabilityState;
  reasonCode: string;
}

export interface BotRuntimeStatus {
  name: string;
  platform: string;
  engine: string;
  model?: string;
  backend: string;
  workdirFingerprint?: string;
  ws: WsConnectionSnapshot | null;
  activeTurns?: number | null;
  capabilities?: RuntimeCapability[];
}

export interface RuntimeStatus {
  releaseSha: string;
  backend: string;
  bots: BotRuntimeStatus[];
}

export interface RuntimeObservation {
  releaseSha: string;
  bots: Array<{
    name: string;
    platform: string;
    engine: string;
    model?: string;
    backend: string;
    activeTurns: number | null;
    channel: { state: WsConnectionState } | null;
  }>;
}

export function resolveReleaseSha(value: string | undefined): string {
  return value?.trim() || 'unknown';
}

export function fingerprintRuntimePath(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readConnectionStatus(
  source: BotRuntimeSource,
): WsConnectionSnapshot | null {
  if (!source.connectionStatus) return null;
  try {
    const status = source.connectionStatus();
    return {
      state: status.state,
      reconnectAttempts: status.reconnectAttempts,
      ...(status.lastConnectTime !== undefined
        ? { lastConnectTime: status.lastConnectTime }
        : {}),
      ...(status.nextConnectTime !== undefined
        ? { nextConnectTime: status.nextConnectTime }
        : {}),
    };
  } catch {
    return null;
  }
}

function readActiveTurns(source: BotRuntimeSource): number | null {
  if (!source.activeTurns) return null;
  try {
    const count = source.activeTurns();
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export function buildRuntimeStatus(input: {
  releaseSha: string;
  bots: BotRuntimeSource[];
}): RuntimeStatus {
  const backends = new Set(input.bots.map(({ backend }) => backend));
  const backend = backends.size === 1
    ? backends.values().next().value ?? 'unknown'
    : backends.size === 0
      ? 'unknown'
      : 'mixed';

  return {
    releaseSha: resolveReleaseSha(input.releaseSha),
    backend,
    bots: input.bots.map((source) => ({
      name: source.name,
      platform: source.platform,
      engine: source.engine,
      ...(source.model ? { model: source.model } : {}),
      backend: source.backend,
      ...(source.workdirFingerprint
        ? { workdirFingerprint: source.workdirFingerprint }
        : {}),
      ws: readConnectionStatus(source),
      ...(source.activeTurns ? { activeTurns: readActiveTurns(source) } : {}),
      ...(source.capabilities
        ? {
          capabilities: source.capabilities.map(({ name, state, reasonCode }) => ({
            name,
            state,
            reasonCode,
          })),
        }
        : {}),
    })),
  };
}

export function buildRuntimeObservation(input: {
  releaseSha: string;
  bots: BotRuntimeSource[];
}): RuntimeObservation {
  const status = buildRuntimeStatus(input);
  return {
    releaseSha: status.releaseSha,
    bots: status.bots.map((bot) => ({
      name: bot.name,
      platform: bot.platform,
      engine: bot.engine,
      ...(bot.model ? { model: bot.model } : {}),
      backend: bot.backend,
      activeTurns: bot.activeTurns ?? null,
      channel: bot.ws ? { state: bot.ws.state } : null,
    })),
  };
}
