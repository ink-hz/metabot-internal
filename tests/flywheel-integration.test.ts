import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createFlywheelRecorder } from '../src/flywheel/index.js';
import { metrics } from '../src/utils/metrics.js';

const databaseUrl = process.env.FLYWHEEL_TEST_DATABASE_URL;
const ownerUrl = process.env.FLYWHEEL_TEST_OWNER_DATABASE_URL;
const enabled = Boolean(databaseUrl && ownerUrl);
let owner = enabled ? new pg.Pool({ connectionString: ownerUrl }) : undefined;

describe.skipIf(!enabled)('flywheel PostgreSQL integration', () => {
  afterAll(async () => { await owner?.end(); });

  it('writes a complete six-event turn and remains non-blocking when PostgreSQL stops', async () => {
    const recorder = createFlywheelRecorder({
      env: {
        FLYWHEEL_ENABLED: 'true',
        FLYWHEEL_DATABASE_URL: databaseUrl,
        FLYWHEEL_RETRY_BASE_MS: '1',
        FLYWHEEL_TIMEOUT_MS: '100',
      },
      logger: { warn() {} } as any,
    });
    const turnId = randomUUID();
    const runId = randomUUID();
    const failedRunId = randomUUID();
    const base = {
      botId: 'hr-bot', turnId, runId,
      conversation: { platform: 'feishu' as const, platform_id: 'integration-chat', type: 'direct' as const },
      sender: { provider: 'feishu' as const, union_id: 'integration-union', open_id: 'integration-open' },
    };

    recorder.recordMessageReceived({ ...base, runId: null, payload: { platform_message_id: 'integration-message', content: '完整问题' } });
    recorder.recordRunStarted({ ...base, payload: { engine: 'claude', backend: 'pty', model: 'integration-model' } });
    recorder.recordToolCall({ ...base, payload: { tool_name: 'Read', status: 'completed', duration_ms: 2 } });
    recorder.recordEvidence({ ...base, payload: { kind: 'tool_io', raw: { result: 'safe' } } });
    recorder.recordRunCompleted({ ...base, payload: { content: '完整回答', input_tokens: 11, output_tokens: 22, duration_ms: 3, cost_usd: 0.01 } });
    recorder.recordRunStarted({ ...base, runId: failedRunId, payload: { engine: 'claude', backend: 'pty' } });
    recorder.recordRunFailed({ ...base, runId: failedRunId, payload: { error_class: 'provider_error', error_message: 'synthetic failure' } });
    await recorder.flush();

    const chain = await owner!.query(`
      select count(*)::int as count
      from flywheel_core.messages m
      join flywheel_trace.runs r on r.turn_id = m.turn_id
      join flywheel_trace.events e on e.run_id = r.id
      join flywheel_evidence.evidence x on x.run_id = r.id
      where r.id = $1 and m.role = 'assistant' and r.status = 'completed'
    `, [runId]);
    expect(chain.rows[0].count).toBeGreaterThan(0);
    const types = await owner!.query<{ event_type: string }>(
      'select distinct event_type from flywheel_trace.events where turn_id = $1', [turnId]);
    expect(types.rows.map((row) => row.event_type).sort()).toEqual([
      'evidence', 'message_received', 'run_completed', 'run_failed', 'run_started', 'tool_call',
    ]);

    const before = counterValue('flywheel_events_dropped_total');
    await owner!.end();
    owner = undefined;
    const stopped = spawnSync(`${process.env.FLYWHEEL_TEST_PG_BINDIR}/pg_ctl`, [
      '-D', process.env.FLYWHEEL_TEST_PGDATA!, '-m', 'immediate', '-w', 'stop',
    ]);
    expect(stopped.status).toBe(0);
    const startedAt = performance.now();
    expect(() => recorder.recordToolCall({ ...base, payload: { tool_name: 'Bash', status: 'failed' } })).not.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(20);
    await recorder.flush();
    expect(counterValue('flywheel_events_dropped_total')).toBe(before + 1);
    await recorder.close();
  });
});

function counterValue(name: string): number {
  const match = metrics.serialize().match(new RegExp(`^${name} (\\d+)$`, 'm'));
  return Number(match?.[1] ?? 0);
}
