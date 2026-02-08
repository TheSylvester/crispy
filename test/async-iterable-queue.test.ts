/**
 * Tests for AsyncIterableQueue
 *
 * Covers: enqueue/next/done flow, post-done guard, pending reader
 * resolution/rejection, single-iteration constraint, from() + return().
 */

import { describe, it, expect, vi } from 'vitest';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';

describe('AsyncIterableQueue', () => {
  it('normal flow: enqueue, read, done', async () => {
    const q = new AsyncIterableQueue<number>();
    q.enqueue(1);
    q.enqueue(2);

    const collected: number[] = [];
    // Signal done after the two items
    q.done();

    for await (const item of q) {
      collected.push(item);
    }

    expect(collected).toEqual([1, 2]);
  });

  it('enqueue after done or error is a no-op', async () => {
    // After done
    const q1 = new AsyncIterableQueue<string>();
    q1.enqueue('a');
    q1.done();
    q1.enqueue('b'); // should be silently ignored

    const items1: string[] = [];
    for await (const item of q1) {
      items1.push(item);
    }
    expect(items1).toEqual(['a']);

    // After error
    const q2 = new AsyncIterableQueue<string>();
    q2.enqueue('x');
    q2.error(new Error('boom'));
    q2.enqueue('y'); // should be silently ignored

    const iter = q2[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({ done: false, value: 'x' });
    await expect(iter.next()).rejects.toThrow('boom');
  });

  it('done/error resolves/rejects a pending reader', async () => {
    // done() with pending reader
    const q1 = new AsyncIterableQueue<string>();
    const iter1 = q1[Symbol.asyncIterator]();
    const pending1 = iter1.next(); // will block — no items queued
    q1.done();
    const result1 = await pending1;
    expect(result1).toEqual({ done: true, value: undefined });

    // error() with pending reader
    const q2 = new AsyncIterableQueue<string>();
    const iter2 = q2[Symbol.asyncIterator]();
    const pending2 = iter2.next(); // will block
    q2.error(new Error('fail'));
    await expect(pending2).rejects.toThrow('fail');
  });

  it('double iteration throws', () => {
    const q = new AsyncIterableQueue<number>();
    q[Symbol.asyncIterator](); // first call sets started=true
    expect(() => q[Symbol.asyncIterator]()).toThrow('Stream can only be iterated once');
  });

  it('from() creates a pre-filled done queue, return() fires onReturn', async () => {
    const q = AsyncIterableQueue.from([10, 20, 30]);

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual([10, 20, 30]);

    // return() with onReturn callback
    const onReturn = vi.fn();
    const q2 = new AsyncIterableQueue<string>(onReturn);
    const result = await q2.return();
    expect(result).toEqual({ done: true, value: undefined });
    expect(onReturn).toHaveBeenCalledOnce();
  });
});
