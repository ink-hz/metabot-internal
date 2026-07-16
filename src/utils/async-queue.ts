/**
 * An async queue that implements AsyncIterable.
 * Producers call enqueue() to push items, consumers use for-await-of to read.
 * finish() signals no more items will be added.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private finished = false;
  private failure: unknown;

  enqueue(item: T): void {
    if (this.finished) return;
    this.queue.push(item);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  finish(): void {
    this.finished = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.failure = error;
    this.finished = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.finished) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}
