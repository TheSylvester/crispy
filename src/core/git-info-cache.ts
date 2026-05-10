/**
 * Git Info Cache — single-flight, TTL stale-while-revalidate cache for getGitBranchInfo
 *
 * Wraps {@link getGitBranchInfo} (file-service.ts). Many UI consumers — the
 * Open Sessions panel, TitleBar, GitPanel — poll the same CWDs. This module
 * absorbs duplicates so we hit `git status` at most once per CWD per 15s.
 *
 * Behavior:
 *   - Cache hit, fresh (<15s): return synchronously.
 *   - Cache hit, stale: return cached value AND kick off background refresh.
 *   - Cache miss: await fetch.
 *   - Single-flight per CWD; at most 4 git subprocesses globally.
 *   - LRU-ish eviction when cache exceeds 100 entries.
 *
 * Errors are swallowed (returned as null) — same contract as the underlying
 * function. On error with a prior value, we keep the stale value but bump
 * fetchedAt to avoid hammering.
 *
 * @module git-info-cache
 */

import { getGitBranchInfo, type GitInfo } from "./file-service.js";

export type { GitInfo };

interface Entry {
  value: GitInfo | null;
  fetchedAt: number;
  inflight?: Promise<GitInfo | null>;
}

const TTL_MS = 8_000;
const MAX_ENTRIES = 100;
const MAX_CONCURRENT = 4;

const cache = new Map<string, Entry>();

let activeFetches = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT) {
    activeFetches++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      activeFetches++;
      resolve();
    });
  });
}

function release(): void {
  activeFetches--;
  const next = waiters.shift();
  if (next) next();
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, entry] of cache) {
    if (entry.fetchedAt < oldestAt) {
      oldestAt = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) cache.delete(oldestKey);
}

async function fetchAndStore(cwd: string, prev: GitInfo | null): Promise<GitInfo | null> {
  await acquire();
  try {
    const value = await getGitBranchInfo(cwd);
    const entry = cache.get(cwd) ?? { value: null, fetchedAt: 0 };
    entry.value = value;
    entry.fetchedAt = Date.now();
    entry.inflight = undefined;
    cache.set(cwd, entry);
    evictIfNeeded();
    return value;
  } catch {
    const entry = cache.get(cwd) ?? { value: null, fetchedAt: 0 };
    entry.value = prev;
    entry.fetchedAt = Date.now();
    entry.inflight = undefined;
    cache.set(cwd, entry);
    evictIfNeeded();
    return prev;
  } finally {
    release();
  }
}

export async function getGitBranchInfoCached(cwd: string): Promise<GitInfo | null> {
  const now = Date.now();
  const entry = cache.get(cwd);

  if (entry) {
    const age = now - entry.fetchedAt;
    if (age < TTL_MS) {
      return entry.value;
    }
    // First fetch is still in flight (placeholder, no real value yet) — await it
    // so concurrent first-callers all share the same result instead of seeing null.
    if (entry.inflight && entry.fetchedAt === 0) {
      return entry.inflight;
    }
    // Stale — kick off background refresh if not already in flight, return cached.
    if (!entry.inflight) {
      entry.inflight = fetchAndStore(cwd, entry.value);
      // Swallow background errors — fetchAndStore already handles them.
      entry.inflight.catch(() => {});
    }
    return entry.value;
  }

  // Miss — await fetch. Single-flight via inflight promise.
  const placeholder: Entry = { value: null, fetchedAt: 0 };
  const promise = fetchAndStore(cwd, null);
  placeholder.inflight = promise;
  cache.set(cwd, placeholder);
  return promise;
}

export function invalidateGitInfo(cwd: string): void {
  cache.delete(cwd);
}
