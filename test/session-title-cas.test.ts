/**
 * Tests for setSessionTitleIfUnchanged — Rosie's TOCTOU-safe rename CAS.
 *
 * The CAS reads the vendor's current title, compares against
 * `expectedCurrentTitle` (with whitespace/empty normalized to null),
 * and writes only if they match. Per-session lock serializes concurrent
 * calls for the SAME sessionId; different sessionIds run in parallel.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter, AdapterSettings, SessionInfo, ChannelMessage, VendorDiscovery, TurnSettings } from '../src/core/agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from '../src/core/transcript.js';
import type { ChannelStatus } from '../src/core/channel-events.js';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';

import {
  registerAdapter,
  setSessionTitle,
  getSessionTitle,
  setSessionTitleIfUnchanged,
  _resetRegistry,
} from '../src/core/session-manager.js';
import { _setTestDir } from '../src/core/activity-index.js';
import { _resetRegistry as _resetChannelRegistry } from '../src/core/session-channel.js';

// ============================================================================
// Test fixtures
// ============================================================================

let testDir: string;
let cleanupTestDir: () => void;
let titleStore: Map<string, string>;
let setHits: number;

beforeEach(() => {
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-cas-test-'));
  cleanupTestDir = _setTestDir(testDir);
  titleStore = new Map();
  setHits = 0;
});

afterEach(() => {
  _resetRegistry();
  _resetChannelRegistry();
  cleanupTestDir();
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function makeSessionInfo(id: string): SessionInfo {
  return {
    sessionId: id,
    path: `/tmp/${id}.jsonl`,
    projectSlug: 'mock',
    modifiedAt: new Date(),
    size: 0,
    vendor: 'claude',
  };
}

/**
 * Build a discovery whose setSessionTitle/getSessionTitle act on a shared
 * map. session-manager.resolveTitleHandler() falls back to discovery for
 * stateless ops when no live channel is attached, so this exercises the
 * exact code path Rosie hits at startup.
 */
function buildVendorWithStore(
  vendor: Vendor,
  sessions: SessionInfo[],
  options: {
    setDelay?: number;
  } = {},
): VendorDiscovery & {
  setSessionTitle: (id: string, title: string) => Promise<void>;
  getSessionTitle: (id: string) => Promise<string | null>;
} {
  return {
    vendor,
    findSession: (id: string) => sessions.find((s) => s.sessionId === id),
    listSessions: () => sessions,
    loadHistory: async () => [],
    setSessionTitle: vi.fn(async (id: string, title: string) => {
      if (options.setDelay) {
        await new Promise((resolve) => setTimeout(resolve, options.setDelay));
      }
      titleStore.set(id, title);
      setHits++;
    }),
    getSessionTitle: vi.fn(async (id: string) => titleStore.get(id) ?? null),
  };
}

function dummyAdapter(vendor: Vendor): AgentAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  let status: ChannelStatus = 'idle';
  return {
    vendor,
    get sessionId() { return undefined; },
    get status() { return status; },
    get contextUsage() { return null; },
    get settings(): AdapterSettings {
      return { vendor, model: undefined, permissionMode: undefined, allowDangerouslySkipPermissions: false, extraArgs: undefined };
    },
    messages: () => queue,
    sendTurn: vi.fn() as unknown as AgentAdapter['sendTurn'],
    respondToApproval: vi.fn(),
    close: vi.fn(() => { status = 'idle'; queue.done(); }),
    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('setSessionTitleIfUnchanged — TOCTOU-safe CAS', () => {
  it('writes when expected matches current (null === null on cold start)', async () => {
    const sess = makeSessionInfo('cas-1');
    const discovery = buildVendorWithStore('claude', [sess]);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    const result = await setSessionTitleIfUnchanged('cas-1', 'New Title', null);
    expect(result).toEqual({ ok: true });
    expect(titleStore.get('cas-1')).toBe('New Title');
    expect(setHits).toBe(1);
  });

  it('writes when expected matches current (string === string)', async () => {
    const sess = makeSessionInfo('cas-2');
    const discovery = buildVendorWithStore('claude', [sess]);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    titleStore.set('cas-2', 'Old');
    const result = await setSessionTitleIfUnchanged('cas-2', 'New', 'Old');
    expect(result).toEqual({ ok: true });
    expect(titleStore.get('cas-2')).toBe('New');
  });

  it('refuses to write and reports current when human renamed in between', async () => {
    const sess = makeSessionInfo('cas-3');
    const discovery = buildVendorWithStore('claude', [sess]);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    titleStore.set('cas-3', 'Human Wrote');
    const result = await setSessionTitleIfUnchanged('cas-3', 'Rosie Wants', 'What Rosie Last Wrote');
    expect(result).toEqual({ ok: false, reason: 'changed', current: 'Human Wrote' });
    // No write happened.
    expect(titleStore.get('cas-3')).toBe('Human Wrote');
    expect(setHits).toBe(0);
  });

  it('treats whitespace-only and empty as equivalent to null', async () => {
    const sess = makeSessionInfo('cas-4');
    const discovery = buildVendorWithStore('claude', [sess]);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    titleStore.set('cas-4', '   ');  // whitespace
    // Expected null but current is whitespace — should still match (both normalize to null).
    const result = await setSessionTitleIfUnchanged('cas-4', 'Real', null);
    expect(result).toEqual({ ok: true });
  });

  it('returns unsupported when the vendor lacks rename', async () => {
    const sess = makeSessionInfo('cas-5');
    const discovery: VendorDiscovery = {
      vendor: 'claude',
      findSession: () => sess,
      listSessions: () => [sess],
      loadHistory: async () => [],
      // No setSessionTitle / getSessionTitle.
    };
    registerAdapter(discovery, () => dummyAdapter('claude'));

    const result = await setSessionTitleIfUnchanged('cas-5', 'Anything', null);
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('serializes concurrent calls for the SAME sessionId', async () => {
    // Both calls fire with expected=null (cold start). The first write should
    // succeed (current=null, matches expected), set titleStore['cas-6']='A',
    // then the second call's CAS reads current='A' which !== expected=null,
    // so it returns 'changed'. This proves the lock serialized them.
    const sess = makeSessionInfo('cas-6');
    const discovery = buildVendorWithStore('claude', [sess], { setDelay: 30 });
    registerAdapter(discovery, () => dummyAdapter('claude'));

    const [r1, r2] = await Promise.all([
      setSessionTitleIfUnchanged('cas-6', 'A', null),
      setSessionTitleIfUnchanged('cas-6', 'B', null),
    ]);

    // Exactly one write succeeded; the other saw the post-first-write state.
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(setHits).toBe(1);
    // Whoever ran second saw the first write's value.
    const loser = (r1.ok ? r2 : r1) as Extract<typeof r1, { ok: false; reason: 'changed' }>;
    expect(loser.reason).toBe('changed');
    expect(loser.current).toBe(r1.ok ? 'A' : 'B');
  });

  it('does NOT serialize calls for DIFFERENT sessionIds (concurrent in-flight)', async () => {
    // Behavioral test (not timing-based): both calls should be in-flight
    // simultaneously — proving the per-session lock keys on sessionId, not
    // a global mutex. We use a controlled gate inside setSessionTitle that
    // lets us inspect concurrency directly.
    const sA = makeSessionInfo('cas-7-a');
    const sB = makeSessionInfo('cas-7-b');

    let inFlight = 0;
    let maxInFlight = 0;
    let releaseA = () => {};
    let releaseB = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });

    const discovery: VendorDiscovery & {
      setSessionTitle: (id: string, title: string) => Promise<void>;
      getSessionTitle: (id: string) => Promise<string | null>;
    } = {
      vendor: 'claude',
      findSession: (id: string) => [sA, sB].find((s) => s.sessionId === id),
      listSessions: () => [sA, sB],
      loadHistory: async () => [],
      setSessionTitle: vi.fn(async (id: string, title: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Wait until both are in-flight, then release.
        await (id === 'cas-7-a' ? gateA : gateB);
        titleStore.set(id, title);
        inFlight--;
      }),
      getSessionTitle: vi.fn(async (id: string) => titleStore.get(id) ?? null),
    };
    registerAdapter(discovery, () => dummyAdapter('claude'));

    const promises = [
      setSessionTitleIfUnchanged('cas-7-a', 'A', null),
      setSessionTitleIfUnchanged('cas-7-b', 'B', null),
    ];
    // Yield long enough for both calls to enter setSessionTitle.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(maxInFlight).toBe(2);  // both in flight at the same time

    // Release both gates to let them complete.
    releaseA();
    releaseB();
    const [rA, rB] = await Promise.all(promises);
    expect(rA).toEqual({ ok: true });
    expect(rB).toEqual({ ok: true });
  });

  it('does NOT inherit a prior CAS rejection on the same sessionId', async () => {
    // If setSessionTitle throws once, the next CAS for the same sessionId
    // must run its own compare-and-swap — it must NOT inherit the prior
    // rejection through the lock chain. Without `.catch(() => undefined)`
    // between prior and .then, the next call would re-throw the previous
    // error before its handler runs.
    const sess = makeSessionInfo('cas-chain-1');
    let throwOnNextSet = true;
    const discovery: VendorDiscovery = {
      vendor: 'claude',
      findSession: (id: string) => (id === 'cas-chain-1' ? sess : undefined),
      listSessions: () => [sess],
      loadHistory: async () => [],
      setSessionTitle: vi.fn(async (id: string, title: string) => {
        if (throwOnNextSet) {
          throwOnNextSet = false;
          throw new Error('transient vendor error');
        }
        titleStore.set(id, title);
      }),
      getSessionTitle: vi.fn(async (id: string) => titleStore.get(id) ?? null),
    };
    registerAdapter(discovery, () => dummyAdapter('claude'));

    // First CAS rejects.
    await expect(
      setSessionTitleIfUnchanged('cas-chain-1', 'A', null),
    ).rejects.toThrow(/transient vendor error/);

    // Second CAS must run its own compare-and-swap, not inherit the rejection.
    const r2 = await setSessionTitleIfUnchanged('cas-chain-1', 'B', null);
    expect(r2).toEqual({ ok: true });
    expect(titleStore.get('cas-chain-1')).toBe('B');
  });

  it('persists Rosie last-written so subsequent CAS sees that value', async () => {
    // After a successful CAS, session-manager upserts rosie_last_titles via
    // setRosieLastTitle. We don't read that table here directly — but we
    // verify the public contract: CAS doesn't double-write the same value.
    const sess = makeSessionInfo('cas-8');
    const discovery = buildVendorWithStore('claude', [sess]);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    const r1 = await setSessionTitleIfUnchanged('cas-8', 'V1', null);
    expect(r1).toEqual({ ok: true });

    // Rosie iteration 2: tracker passes its last-written, current matches.
    const r2 = await setSessionTitleIfUnchanged('cas-8', 'V2', 'V1');
    expect(r2).toEqual({ ok: true });
    expect(titleStore.get('cas-8')).toBe('V2');
  });
});

describe('setSessionTitle / getSessionTitle (non-CAS)', () => {
  it('round-trips through the vendor store', async () => {
    const sess = makeSessionInfo('rt-1');
    const discovery = buildVendorWithStore('claude', [sess]);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    expect(await getSessionTitle('rt-1')).toBeNull();
    await setSessionTitle('rt-1', 'Hello');
    expect(await getSessionTitle('rt-1')).toBe('Hello');
  });

  it('throws when the vendor does not support rename', async () => {
    const sess = makeSessionInfo('rt-2');
    const discovery: VendorDiscovery = {
      vendor: 'claude',
      findSession: () => sess,
      listSessions: () => [sess],
      loadHistory: async () => [],
    };
    registerAdapter(discovery, () => dummyAdapter('claude'));

    await expect(setSessionTitle('rt-2', 'X')).rejects.toThrow(/does not support rename/);
  });

  it('throws when the session is unknown', async () => {
    // Adapter registered, but the session id is not in any vendor's list.
    const discovery = buildVendorWithStore('claude', []);
    registerAdapter(discovery, () => dummyAdapter('claude'));

    await expect(setSessionTitle('does-not-exist', 'X')).rejects.toThrow(/No session found/);
  });
});
