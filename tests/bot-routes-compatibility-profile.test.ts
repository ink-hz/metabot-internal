import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBotsConfig } from '../src/api/bots-config-writer.js';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import { webBotFromJson } from '../src/config.js';
import { OPUS_PROFILE } from '../src/engines/claude/compatibility/profile.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as any;

function makeReq(body: unknown): any {
  const req = new EventEmitter() as any;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes(): any {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body: string) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

describe('runtime bot create with a Claude compatibility profile', () => {
  let rootDir: string;
  let configPath: string;
  let register: ReturnType<typeof vi.fn>;
  let ctx: RouteContext;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-runtime-profile-'));
    configPath = path.join(rootDir, 'bots.json');
    fs.writeFileSync(configPath, JSON.stringify({ webBots: [] }));
    vi.stubEnv('SESSION_STORE_DIR', path.join(rootDir, 'sessions'));
    vi.stubEnv('METABOT_CLAUDE_COMPAT_PROFILE', OPUS_PROFILE.id);
    vi.stubEnv('CLAUDE_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', '');
    register = vi.fn();
    ctx = {
      registry: {
        register,
        get: vi.fn(),
        list: vi.fn(() => []),
      } as any,
      logger,
      botsConfigPath: configPath,
      peerManager: undefined,
      ws: { handle: { broadcastBotList: vi.fn() } as any },
    } as RouteContext;
  });

  afterEach(() => {
    for (const [registered] of register.mock.calls) {
      registered.bridge?.destroy();
    }
    vi.unstubAllEnvs();
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createWebBot(model?: string) {
    const res = makeRes();
    await handleBotRoutes(
      ctx,
      makeReq({
        platform: 'web',
        name: 'runtime-profile-test',
        engine: 'claude',
        defaultWorkingDirectory: path.join(rootDir, 'workdir'),
        ...(model ? { model } : {}),
      }),
      res,
      'POST',
      '/api/bots',
    );
    return res;
  }

  async function updateWebBot(model: string) {
    fs.writeFileSync(configPath, JSON.stringify({
      webBots: [{
        name: 'runtime-profile-test',
        engine: 'claude',
        defaultWorkingDirectory: path.join(rootDir, 'workdir'),
        model: 'claude-opus-4-8',
      }],
    }));
    const res = makeRes();
    await handleBotRoutes(
      ctx,
      makeReq({ model }),
      res,
      'PUT',
      '/api/bots/runtime-profile-test',
    );
    return res;
  }

  it('does not persist or activate an explicitly disallowed model', async () => {
    const res = await createWebBot('claude-fable-5');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/claude-fable-5.*not allowed/);
    expect(readBotsConfig(configPath).webBots).toEqual([]);
    expect(register).not.toHaveBeenCalled();
  });

  it('activates Opus 4.8 when model is omitted', async () => {
    const res = await createWebBot();

    expect(res.statusCode).toBe(201);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0][0].config.claude.model).toBe('claude-opus-4-8');
    const persisted = readBotsConfig(configPath).webBots?.[0];
    expect(webBotFromJson(persisted!).claude.model).toBe('claude-opus-4-8');
  });

  it('does not persist a disallowed model update', async () => {
    const res = await updateWebBot('claude-fable-5');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/claude-fable-5.*not allowed/);
    expect(readBotsConfig(configPath).webBots?.[0].model).toBe('claude-opus-4-8');
  });

  it('falls back to Opus 4.8 when an explicit model is cleared', async () => {
    const res = await updateWebBot('');

    expect(res.statusCode).toBe(200);
    const persisted = readBotsConfig(configPath).webBots?.[0];
    expect(webBotFromJson(persisted!).claude.model).toBe('claude-opus-4-8');
  });
});
