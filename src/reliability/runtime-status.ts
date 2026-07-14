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
  connectionStatus?: () => WsConnectionSnapshot;
}

export interface BotRuntimeStatus {
  name: string;
  platform: string;
  engine: string;
  model?: string;
  backend: string;
  ws: WsConnectionSnapshot | null;
}

export interface RuntimeStatus {
  releaseSha: string;
  backend: string;
  bots: BotRuntimeStatus[];
}

export function resolveReleaseSha(value: string | undefined): string {
  return value?.trim() || 'unknown';
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
      ws: readConnectionStatus(source),
    })),
  };
}
