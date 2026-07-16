import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStore } from '../src/api/activity-store.js';
import { loadOrCreateInstanceId } from '../src/runtime/instance-identity.js';

const dirs: string[] = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runtime instance identity', () => {
  it('creates one stable non-secret identity with owner-only permissions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-instance-'));
    dirs.push(dir);
    const first = loadOrCreateInstanceId(dir);
    const second = loadOrCreateInstanceId(dir);

    expect(second).toBe(first);
    expect(first).toMatch(/^metabot-[0-9a-f]{12}$/);
    expect(fs.statSync(path.join(dir, 'instance-id')).mode & 0o777).toBe(0o600);
  });
});

describe('ActivityStore lifecycle metadata', () => {
  it('persists correlation IDs, phase, instance and sanitized error class', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-activity-'));
    dirs.push(dir);
    vi.stubEnv('SESSION_STORE_DIR', dir);
    const store = new ActivityStore(logger);
    try {
      store.record({
        type: 'task_failed', botName: 'hr-bot', chatId: 'chat', timestamp: 1,
        turnId: 'turn-1', attemptId: 'attempt-1', instanceId: 'metabot-123456789abc',
        phase: 'process_starting', errorClass: 'claude_process_exit',
      });
      expect(store.list({ limit: 1 })[0]).toMatchObject({
        turnId: 'turn-1', attemptId: 'attempt-1', instanceId: 'metabot-123456789abc',
        phase: 'process_starting', errorClass: 'claude_process_exit',
      });
    } finally {
      store.close();
    }
  });
});
