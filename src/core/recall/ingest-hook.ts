/**
 * Recall Ingest Hook — Real-time message indexing on each turn
 *
 * Registers as a responseComplete (phase 1) lifecycle handler. On each turn
 * completion, re-ingests the session's messages into the FTS5 index so that
 * Recall can find content from active sessions — not just after backfill.
 *
 * Also exports `ingestAndEmbedSession` for direct invocation by callers that
 * bypass the lifecycle pubsub (e.g. child-session idle paths in session-manager,
 * where firing the pubsub would trigger Rosie recursion).
 *
 * Lightweight: no LLM calls, just SQLite reads/writes. Typically completes
 * in single-digit milliseconds while Rosie Summarize (same phase) waits
 * for its LLM response.
 *
 * @module recall/ingest-hook
 */

import { onResponseComplete } from '../lifecycle-hooks.js';
import { ingestSessionMessages, embedSessionMessages } from './message-ingest.js';
import { isSystemSession } from '../activity-index.js';
import { log } from '../log.js';

// ============================================================================
// Module State
// ============================================================================

let unsubscribe: (() => void) | null = null;

// ============================================================================
// Ingest
// ============================================================================

export async function ingestAndEmbedSession(sessionId: string): Promise<void> {
  if (sessionId.startsWith('pending:')) return;
  if (isSystemSession(sessionId)) return;

  try {
    const result = await ingestSessionMessages(sessionId);

    if (result.error) {
      log({
        source: 'recall-ingest',
        level: 'warn',
        summary: `Ingest failed: ${result.error}`,
        data: { sessionId },
      });
    } else if (!result.skipped) {
      log({
        source: 'recall-ingest',
        level: 'info',
        summary: `Ingest: ${result.chunksCreated} messages indexed`,
        data: { sessionId, messages: result.chunksCreated },
      });

      embedSessionMessages(sessionId)
        .then(count => {
          if (count > 0) {
            log({
              source: 'recall-ingest',
              level: 'info',
              summary: `Embed: ${count} messages vectorized`,
              data: { sessionId, embedded: count },
            });
          }
        })
        .catch(err => {
          log({
            source: 'recall-ingest',
            level: 'warn',
            summary: `Embed failed: ${err instanceof Error ? err.message : String(err)}`,
            data: { sessionId },
          });
        });
    }
  } catch (err) {
    log({ level: 'warn', source: 'recall-ingest', summary: `hook failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

export function initRecallIngest(): void {
  unsubscribe = onResponseComplete(ingestAndEmbedSession);
}

export function shutdownRecallIngest(): void {
  unsubscribe?.();
  unsubscribe = null;
}
