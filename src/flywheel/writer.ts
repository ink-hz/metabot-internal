import pg from 'pg';
import type { FlywheelEventEnvelope } from './envelope.js';

export type WriteStatus = 'committed' | 'duplicate' | 'rejected';

export interface FlywheelWriter {
  write(event: FlywheelEventEnvelope): Promise<WriteStatus>;
  ping?(): Promise<void>;
  close(): Promise<void> | void;
}

export class PgFlywheelWriter implements FlywheelWriter {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }

  async write(event: FlywheelEventEnvelope): Promise<WriteStatus> {
    const result = await this.pool.query<{ result: { status: WriteStatus } }>(
      'select flywheel_api.ingest_event($1::jsonb) as result',
      [JSON.stringify(event)],
    );
    return result.rows[0]?.result.status ?? 'rejected';
  }

  async ping(): Promise<void> {
    await this.pool.query('select flywheel_api.ping()');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
