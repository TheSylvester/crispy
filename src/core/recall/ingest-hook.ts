/**
 * Recall Ingest Hook — Real-time message indexing on each turn
 *
 * Registers as a responseComplete (phase 1) lifecycle handler. On each turn
 * completion, re-ingests the session's messages into the FTS5 index so that
 * Recall can find content from active sessions — not just after backfill.
 *
 * Lightweight: no LLM calls, just SQLite reads/writes. Typically completes
 * in single-digit milliseconds while Rosie Summarize (same phase) waits
 * for its LLM response.
 *
 * @module recall/ingest-hook
 */

import { onResponseComplete } from '../lifecycle-hooks.js';
import { ingestSessionMessages } from './message-ingest.js';
import { pushRosieLog } from '../rosie/debug-log.js';

// ============================================================================
// Module State
// ============================================================================

let unsubscribe: (() => void) | null = null;

// ============================================================================
// Lifecycle
// ============================================================================

export function initRecallIngest(): void {
  unsubscribe = onResponseComplete(async (sessionId: string) => {
    // Skip pending sessions — they don't have persisted transcripts yet
    if (sessionId.startsWith('pending:')) return;

    try {
      const result = await ingestSessionMessages(sessionId, { force: true });

      if (result.error) {
        pushRosieLog({
          source: 'recall-ingest',
          level: 'warn',
          summary: `Ingest failed: ${result.error}`,
          data: { sessionId },
        });
      } else if (!result.skipped) {
        pushRosieLog({
          source: 'recall-ingest',
          level: 'info',
          summary: `Ingest: ${result.chunksCreated} messages indexed`,
          data: { sessionId, messages: result.chunksCreated },
        });
      }
    } catch (err) {
      // Fire-and-forget — never crash the lifecycle pipeline
      console.warn('[recall-ingest] hook failed:', err);
    }
  });
}

export function shutdownRecallIngest(): void {
  unsubscribe?.();
  unsubscribe = null;
}
