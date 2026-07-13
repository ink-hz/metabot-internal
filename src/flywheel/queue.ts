import type { Logger } from '../utils/logger.js';
import type { FlywheelEventEnvelope } from './envelope.js';
import type { FlywheelWriter, WriteStatus } from './writer.js';

export interface CounterSink {
  incCounter(name: string, label?: string, amount?: number): void;
}

export interface FlywheelQueueOptions {
  capacity: number;
  batchSize: number;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs?: number;
}

export class FlywheelQueue {
  private readonly items: FlywheelEventEnvelope[] = [];
  private drainPromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly writer: FlywheelWriter,
    private readonly logger: Logger,
    private readonly counters: CounterSink,
    private readonly options: FlywheelQueueOptions,
  ) {}

  enqueue(event: FlywheelEventEnvelope): boolean {
    if (this.closed || this.items.length >= this.options.capacity) {
      this.drop(event, this.closed ? 'queue_closed' : 'queue_full');
      return false;
    }
    this.items.push(event);
    this.counters.incCounter('flywheel_events_accepted_total');
    queueMicrotask(() => this.ensureDrain());
    return true;
  }

  async flush(): Promise<void> {
    while (this.items.length > 0 || this.drainPromise) {
      this.ensureDrain();
      await this.drainPromise;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.writer.close();
  }

  private ensureDrain(): void {
    if (this.drainPromise || this.items.length === 0) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.items.length > 0) this.ensureDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.items.length > 0) {
      const batch = this.items.splice(0, this.options.batchSize);
      for (const event of batch) await this.writeWithRetry(event);
    }
  }

  private async writeWithRetry(event: FlywheelEventEnvelope): Promise<void> {
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        const status = await withTimeout(this.writer.write(event), this.options.timeoutMs);
        this.countStatus(status);
        return;
      } catch {
        if (attempt < this.options.maxAttempts) {
          await delay((this.options.retryBaseMs ?? 100) * 2 ** (attempt - 1));
        }
      }
    }
    this.counters.incCounter('flywheel_events_failed_total');
    this.drop(event, 'write_failed');
  }

  private countStatus(status: WriteStatus): void {
    this.counters.incCounter(`flywheel_events_${status}_total`);
  }

  private drop(event: FlywheelEventEnvelope, failureCategory: string): void {
    this.counters.incCounter('flywheel_events_dropped_total');
    this.logger.warn({
      event_id: event.event_id,
      bot_id: event.bot_id,
      event_type: event.event_type,
      failure_category: failureCategory,
    }, 'Flywheel event dropped');
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
