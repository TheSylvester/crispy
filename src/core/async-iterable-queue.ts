/**
 * An async iterable queue that allows enqueuing items and consuming them asynchronously.
 *
 * This is used for streaming messages between the webview and the SDK:
 * - UserMessages are enqueued from the webview
 * - The SDK consumes them via async iteration
 */
export class AsyncIterableQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private queue: T[] = [];
  private readResolve?: (result: IteratorResult<T>) => void;
  private readReject?: (error: Error) => void;
  private isDone = false;
  private hasError?: Error;
  private started = false;

  /**
   * Optional callback when the iterator is returned (cleanup).
   */
  constructor(private onReturn?: () => void) {}

  /**
   * Get the async iterator. Can only be iterated once.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.started) {
      throw new Error('Stream can only be iterated once');
    }
    this.started = true;
    return this;
  }

  /**
   * Get the next value from the queue.
   * Resolves immediately if items are queued, otherwise waits for enqueue/done/error.
   */
  next(): Promise<IteratorResult<T>> {
    // If there are items in the queue, return immediately
    if (this.queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.queue.shift()!,
      });
    }

    // If done, return done result
    if (this.isDone) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }

    // If there's an error, reject
    if (this.hasError) {
      return Promise.reject(this.hasError);
    }

    // Otherwise, wait for the next enqueue/done/error
    return new Promise((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

  /**
   * Add an item to the queue.
   * If there's a pending reader, it will be resolved immediately.
   * Silently ignored if the queue is already done (no-op).
   */
  enqueue(value: T): void {
    if (this.isDone || this.hasError) return;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({
        done: false,
        value,
      });
    } else {
      this.queue.push(value);
    }
  }

  /**
   * Mark the queue as done (no more items will be enqueued).
   */
  done(): void {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({
        done: true,
        value: undefined,
      });
    }
  }

  /**
   * Mark the queue as errored.
   */
  error(err: Error): void {
    this.hasError = err;
    if (this.readReject) {
      const reject = this.readReject;
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(err);
    }
  }

  /**
   * Return/cleanup the iterator.
   */
  return(): Promise<IteratorResult<T>> {
    this.isDone = true;
    this.onReturn?.();
    return Promise.resolve({
      done: true,
      value: undefined,
    });
  }

  /**
   * Create an AsyncIterableQueue from an iterable (useful for testing).
   */
  static from<T>(iterable: Iterable<T>): AsyncIterableQueue<T> {
    const queue = new AsyncIterableQueue<T>();
    for (const item of iterable) {
      queue.enqueue(item);
    }
    queue.done();
    return queue;
  }
}
