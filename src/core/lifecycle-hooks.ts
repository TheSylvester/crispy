/**
 * Lifecycle Hooks — Feature registration for session lifecycle events
 *
 * Lightweight pub/sub for session lifecycle phases. Features (Rosie, future
 * auto-tagging, etc.) register handlers instead of being hardcoded into
 * session-manager.ts.
 *
 * Design:
 * - Module-level state, free functions (matches session-channel.ts pattern)
 * - Named functions per phase (no generic phase map)
 * - Error-isolated: one handler failing never blocks others
 * - Handlers run concurrently via Promise.allSettled
 * - Child session guard: sessions spawned via dispatchChildSession() are
 *   automatically excluded — prevents recursive hook chains (e.g. Rosie
 *   analyzing its own child sessions). This guard lives here, not in
 *   individual handlers, so every current and future handler gets it for free.
 *
 * Only phase for now: responseComplete (end of turn, after JSONL flush).
 * Add promptSubmit etc. when needed — copy the pattern.
 *
 * @module lifecycle-hooks
 */

import { isChildSession } from './session-manager.js';
import { pushRosieLog } from './rosie/index.js';

// ============================================================================
// Types
// ============================================================================

/** Handler invoked after a turn completes (adapter idle + JSONL flushed). */
export type ResponseCompleteHandler = (sessionId: string) => void | Promise<void>;

// ============================================================================
// Module State
// ============================================================================

const responseCompleteHandlers = new Set<ResponseCompleteHandler>();
const responseCompleteAfterHandlers = new Set<ResponseCompleteHandler>();

// ============================================================================
// Registration
// ============================================================================

/**
 * Register a handler for the responseComplete phase.
 * Returns an unsubscribe function.
 */
export function onResponseComplete(handler: ResponseCompleteHandler): () => void {
  responseCompleteHandlers.add(handler);
  return () => { responseCompleteHandlers.delete(handler); };
}

/**
 * Register a handler for phase 2 of responseComplete.
 * Phase-2 handlers fire AFTER all phase-1 handlers have settled.
 * Use this when your handler depends on side effects from phase-1
 * (e.g. tracker reads rosie-meta written by summarize in phase 1).
 * Returns an unsubscribe function.
 */
export function onResponseCompleteAfter(handler: ResponseCompleteHandler): () => void {
  responseCompleteAfterHandlers.add(handler);
  return () => { responseCompleteAfterHandlers.delete(handler); };
}

// ============================================================================
// Firing
// ============================================================================

/**
 * Fire all responseComplete handlers concurrently.
 * Errors are logged but never propagate — one handler failing cannot
 * block others or crash the session lifecycle.
 *
 * Child sessions (spawned via dispatchChildSession) are silently skipped —
 * this prevents recursive hook chains where a handler's own child session
 * would re-trigger the same handler.
 */
export async function fireResponseComplete(sessionId: string): Promise<void> {
  // Guard: never fire hooks for sessions spawned by dispatchChildSession.
  // This prevents recursive chains (e.g. Rosie → child idle → Rosie → ∞).
  // Covers all handlers — individual features don't need their own guard.
  if (isChildSession(sessionId)) return;

  if (responseCompleteHandlers.size === 0 && responseCompleteAfterHandlers.size === 0) return;

  // Phase 1: run all primary handlers concurrently
  if (responseCompleteHandlers.size > 0) {
    const results = await Promise.allSettled(
      [...responseCompleteHandlers].map((handler) => Promise.resolve(handler(sessionId))),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        pushRosieLog({ level: 'warn', source: 'lifecycle-hooks', summary: `responseComplete handler failed: ${result.reason}`, data: { reason: result.reason } });
      }
    }
  }

  // Phase 2: run after-handlers concurrently (depend on phase-1 side effects)
  if (responseCompleteAfterHandlers.size > 0) {
    const afterResults = await Promise.allSettled(
      [...responseCompleteAfterHandlers].map((handler) => Promise.resolve(handler(sessionId))),
    );
    for (const result of afterResults) {
      if (result.status === 'rejected') {
        pushRosieLog({ level: 'warn', source: 'lifecycle-hooks', summary: `responseCompleteAfter handler failed: ${result.reason}`, data: { reason: result.reason } });
      }
    }
  }
}

// ============================================================================
// Test Helper
// ============================================================================

/** Clear all registered handlers. Test helper only. */
export function _clearAllHooks(): void {
  responseCompleteHandlers.clear();
  responseCompleteAfterHandlers.clear();
}
