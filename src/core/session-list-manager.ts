/**
 * Session List Manager — Push-based session list notifications
 *
 * Functional module-level API (matches session-channel.ts / session-manager.ts patterns).
 * Manages subscribers interested in session list changes and a periodic
 * rescan that catches sessions created externally (e.g., Claude Code CLI).
 *
 * Three triggers for session list updates:
 * 1. Session creation — instant push when a new session gets its real ID
 * 2. End of turn — push when adapter status transitions to idle
 * 3. Periodic rescan (~30s) — catches sessions created externally
 *
 * @module session-list-manager
 */

import type { SessionInfo } from './agent-adapter.js';
import type { SessionListEvent } from './session-list-events.js';
import { findSession, listAllSessions } from './session-manager.js';

// ============================================================================
// Subscriber Interface
// ============================================================================

/** A subscriber interested in session list changes. */
export interface SessionListSubscriber {
  readonly id: string;
  send(event: SessionListEvent): void;
}

// ============================================================================
// Module State
// ============================================================================

/** Active subscribers. */
const subscribers = new Map<string, SessionListSubscriber>();

/** Cache of known sessions — keyed by sessionId, value is last-known modifiedAt timestamp. */
const knownSessions = new Map<string, { modifiedAt: number }>();

/** Rescan interval handle. */
let rescanTimer: ReturnType<typeof setInterval> | null = null;

const RESCAN_INTERVAL_MS = 30_000;

// ============================================================================
// Subscribe / Unsubscribe
// ============================================================================

/** Subscribe to session list changes. Idempotent by ID. */
export function subscribeSessionList(sub: SessionListSubscriber): void {
  subscribers.set(sub.id, sub);
}

/** Unsubscribe from session list changes. Accepts subscriber or ID. */
export function unsubscribeSessionList(subOrId: SessionListSubscriber | string): void {
  const id = typeof subOrId === 'string' ? subOrId : subOrId.id;
  subscribers.delete(id);
}

// ============================================================================
// Notification
// ============================================================================

/** Broadcast a session upsert to all subscribers. */
export function notifyUpsert(session: SessionInfo): void {
  knownSessions.set(session.sessionId, { modifiedAt: session.modifiedAt.getTime() });

  const event: SessionListEvent = { type: 'session_list_upsert', session };
  for (const [, sub] of subscribers) {
    try {
      sub.send(event);
    } catch {
      // Bad subscriber — swallow error, don't crash the manager
    }
  }
}

/** Remove a session from the cache and broadcast removal to all subscribers. */
function notifyRemoval(sessionId: string): void {
  knownSessions.delete(sessionId);

  const event: SessionListEvent = { type: 'session_list_remove', sessionId };
  for (const [, sub] of subscribers) {
    try {
      sub.send(event);
    } catch {
      // Bad subscriber — swallow error, don't crash the manager
    }
  }
}

/**
 * Re-read a session's metadata from disk and push an upsert if found.
 *
 * Called after idle transitions and session creation — the adapter may
 * have updated the session's title, lastMessage, or timestamp.
 */
export function refreshAndNotify(sessionId: string): void {
  const info = findSession(sessionId);
  if (info) {
    notifyUpsert(info);
  }
}

// ============================================================================
// Periodic Rescan
// ============================================================================

/**
 * Start the periodic rescan. Seeds the cache from listAllSessions(),
 * then rescans every RESCAN_INTERVAL_MS and emits upserts for
 * new or changed sessions.
 */
export function startRescan(): void {
  if (rescanTimer) return; // Already running

  // Seed the cache
  seedCache();

  rescanTimer = setInterval(() => {
    rescan();
  }, RESCAN_INTERVAL_MS);
}

/** Stop the periodic rescan. */
export function stopRescan(): void {
  if (rescanTimer) {
    clearInterval(rescanTimer);
    rescanTimer = null;
  }
}

/** Seed the cache from current sessions without emitting events. */
function seedCache(): void {
  try {
    const all = listAllSessions();
    for (const session of all) {
      knownSessions.set(session.sessionId, { modifiedAt: session.modifiedAt.getTime() });
    }
  } catch {
    // Discovery may not be ready yet — no-op, rescan will catch up
  }
}

/** Rescan and emit upserts for new/changed sessions, removals for disappeared ones. */
function rescan(): void {
  try {
    const all = listAllSessions();

    // Build set of live IDs from this scan
    const liveIds = new Set<string>();
    for (const session of all) {
      liveIds.add(session.sessionId);
      const known = knownSessions.get(session.sessionId);
      const modifiedAt = session.modifiedAt.getTime();

      if (!known || known.modifiedAt !== modifiedAt) {
        notifyUpsert(session);
      }
    }

    // Detect disappeared sessions: in cache but not in live set
    const staleIds: string[] = [];
    for (const id of knownSessions.keys()) {
      if (!liveIds.has(id)) {
        staleIds.push(id);
      }
    }
    for (const id of staleIds) {
      notifyRemoval(id);
    }
  } catch {
    // Discovery error — skip this cycle, try again next interval
  }
}

// ============================================================================
// Test Helper
// ============================================================================

/** Reset all module state — test helper only. */
export function _reset(): void {
  stopRescan();
  subscribers.clear();
  knownSessions.clear();
}
