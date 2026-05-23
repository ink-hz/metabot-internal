import * as http from 'node:http';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from './bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { DocSync } from '../sync/doc-sync.js';
import type { PeerManager } from './peer-manager.js';

import { AsyncTaskStore } from './async-task-store.js';
import { setupWebSocketServer, serveStaticFiles, type WebSocketHandle } from '../web/ws-server.js';
import { IntentRouter } from './intent-router.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { BudgetManager } from './budget-manager.js';
import { TeamManager } from './team-manager.js';
import { VoiceMeetingService } from './voice-meeting.js';
import { VoiceIdentityStore } from './voice-identity.js';
import { RtcVoiceChatService } from './rtc-voice-chat.js';
import { ActivityStore } from './activity-store.js';
import { metrics as _metrics } from '../utils/metrics.js';
import type { SessionRegistry } from '../session/session-registry.js';
import {
  jsonResponse,
  handleVoiceRoutes,
  handleFileRoutes,
  handleTeamRoutes,
  handleTaskRoutes,
  handleBotRoutes,
  handleSyncRoutes,
  handleRtcRoutes,
  handleSessionRoutes,
  handleExecutorRoutes,
} from './routes/index.js';
import type { RouteContext } from './routes/index.js';

interface ApiServerOptions {
  port: number;
  secret?: string;
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  circuitBreaker?: CircuitBreaker;
  budgetManager?: BudgetManager;
  teamManager?: TeamManager;
  sessionRegistry?: SessionRegistry;
}

const startTime = Date.now();
// Expose start time for metrics route
(globalThis as any).__metabot_start_time = startTime;

const WHOAMI_VERIFY_TIMEOUT_MS = 5_000;

/**
 * Routes that accept the dual-auth gate: local secret OR a Bearer that
 * metabot-core `/api/whoami` validates. Covers the cross-bridge RPC entry
 * points (`/api/talk`, `/api/tasks`) plus the read-only peer-discovery
 * endpoints that peer-manager polls — without these, peer state can never
 * become healthy across hosts that don't share a local secret.
 */
export function isCrossVerifyRoute(method: string, url: string): boolean {
  if (method === 'POST' && (url === '/api/talk' || url.startsWith('/api/talk?'))) return true;
  if (method === 'POST' && (url === '/api/tasks' || url.startsWith('/api/tasks?'))) return true;
  if (method === 'GET' && url.startsWith('/api/talk/')) return true;
  if (method === 'GET' && (url === '/api/bots' || url.startsWith('/api/bots?'))) return true;
  if (method === 'GET' && (url === '/api/skills' || url.startsWith('/api/skills?'))) return true;
  if (method === 'GET' && (url === '/api/peers' || url.startsWith('/api/peers?'))) return true;
  return false;
}

function metabotCoreBaseUrl(): string | undefined {
  const candidates = [process.env.METABOT_CORE_AGENT_BUS_URL, process.env.METABOT_CORE_URL];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, '');
  }
  return undefined;
}

/**
 * Verify a Bearer header against metabot-core `GET /api/whoami`. Returns true
 * only on HTTP 200. Fails closed on any error (network, non-200, timeout).
 */
async function verifyBearerViaMetabotCore(
  authHeader: string,
  logger: Logger,
): Promise<boolean> {
  const base = metabotCoreBaseUrl();
  if (!base) {
    logger.warn(
      'cross-bridge talk attempted but METABOT_CORE_AGENT_BUS_URL/METABOT_CORE_URL is unset — cannot verify',
    );
    return false;
  }
  try {
    const resp = await fetch(`${base}/api/whoami`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(WHOAMI_VERIFY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'whoami verification failed');
    return false;
  }
}

export function startApiServer(options: ApiServerOptions): http.Server {
  const { port, secret, registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient, peerManager } = options;
  const host = secret ? '0.0.0.0' : '127.0.0.1';

  // Initialize shared services
  const asyncTaskStore = new AsyncTaskStore();
  const intentRouter = new IntentRouter(logger);
  const circuitBreaker = options.circuitBreaker ?? new CircuitBreaker(logger);
  const budgetManager = options.budgetManager ?? new BudgetManager(logger);
  const teamManager = options.teamManager ?? new TeamManager(logger);
  const meetingService = new VoiceMeetingService(registry, logger);
  const voiceIdentityStore = new VoiceIdentityStore(logger);
  const activityStore = new ActivityStore(logger);
  const rtcService = new RtcVoiceChatService(logger);
  if (rtcService.isConfigured()) {
    logger.info('RTC voice chat service enabled');
  }

  const ws: { handle?: WebSocketHandle } = {};

  // Build route context (shared across all route handlers)
  const ctx: RouteContext = {
    registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient,
    peerManager,
    asyncTaskStore, intentRouter, circuitBreaker, budgetManager,
    teamManager, meetingService, voiceIdentityStore,
    rtcService: rtcService.isConfigured() ? rtcService : undefined,
    ws,
    sessionRegistry: options.sessionRegistry,
    activityStore,
  };

  // Route handlers in priority order
  const routeHandlers = [
    handleVoiceRoutes,
    handleFileRoutes,
    handleTeamRoutes,
    handleTaskRoutes,
    handleBotRoutes,
    handleSyncRoutes,
    handleRtcRoutes,
    handleSessionRoutes,
    handleExecutorRoutes,
  ];

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // Auth check (exempt /web/, /api/files/).
    //
    // /api/talk and /api/tasks routes accept dual auth: the local secret
    // (mb shortcut, local cross-bot dispatch) OR any Bearer that metabot-core
    // `GET /api/whoami` validates (cross-bridge peer calls, `metabot agents
    // talk` from any user with a metabot-core token). Every other API stays
    // single-secret.
    if (secret && !url.startsWith('/web') && !url.startsWith('/api/files/')) {
      const auth = req.headers.authorization;
      const urlToken = url.includes('token=')
        ? new URL(url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token')
        : null;
      const localOk = auth === `Bearer ${secret}` || urlToken === secret;

      if (!localOk) {
        const canCrossVerify = isCrossVerifyRoute(method, url) && typeof auth === 'string' && /^Bearer\s+/i.test(auth);
        if (!canCrossVerify) {
          jsonResponse(res, 401, { error: 'Unauthorized' });
          return;
        }
        const verified = await verifyBearerViaMetabotCore(auth!, logger);
        if (!verified) {
          jsonResponse(res, 401, { error: 'Unauthorized' });
          return;
        }
      }
    }

    try {
      // GET /api/health — always handled here (lightweight)
      if (method === 'GET' && url === '/api/health') {
        const peerStatuses = peerManager?.getPeerStatuses() ?? [];
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          bots: registry.list().length,
          peerBots: peerManager?.getPeerBots().length ?? 0,
          peers: peerStatuses.length,
          peersHealthy: peerStatuses.filter((p) => p.healthy).length,
          scheduledTasks: scheduler.taskCount(),
          recurringTasks: scheduler.recurringTaskCount(),
        });
        return;
      }

      // Dispatch to route handlers
      for (const handler of routeHandlers) {
        if (await handler(ctx, req, res, method, url)) return;
      }

      // Static file serving for Web UI
      if (serveStaticFiles(req, res, url)) return;

      // 404 fallback
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        logger.error({ err, method, url }, 'API request error');
      }
      jsonResponse(res, statusCode, { error: err.message || 'Internal server error' });
    }
  });

  // Set up WebSocket server for Web UI streaming
  ws.handle = setupWebSocketServer(server, registry, logger, secret, peerManager, options.sessionRegistry);

  // Wire WebSocket handle to scheduler so scheduled tasks stream updates to clients
  scheduler.setWebSocketHandle(ws.handle);

  // Wire activity events: each bridge records to ActivityStore and broadcasts to WS clients
  for (const bot of registry.listRegistered()) {
    bot.bridge.onActivityEvent = (event) => {
      const recorded = activityStore.record(event);
      ws.handle?.broadcastAll({ type: 'activity_event', event: recorded });
    };
  }

  server.listen(port, host, () => {
    logger.info({ host, port }, 'API server started');
  });

  return server;
}
