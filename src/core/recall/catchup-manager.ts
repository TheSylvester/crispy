/**
 * Recall Catch-up Manager — FTS5 catch-up + embedding backfill orchestration
 *
 * Runs on activation to bring the recall index up to date:
 *   1. FTS5 catch-up: silently indexes all unindexed sessions (fast)
 *   2. Gap detection: counts messages without embedding vectors
 *   3. Model download: ensures the GGUF model exists on disk
 *   4. Embedding backfill: embeds unvectorized messages via llama-embedding
 *
 * Uses a dedicated pub/sub channel (not session-channel) for status events,
 * following the pattern established by debug-log.ts.
 *
 * Owns: catch-up lifecycle, gap detection, background embedding orchestration,
 *       dedicated channel pub/sub for status events.
 * Does not: render UI, route RPCs, touch ~/.crispy/ directly (uses message-store).
 *
 * @module recall/catchup-manager
 */

import { existsSync } from 'node:fs';
import { freemem } from 'node:os';
import { listAllSessions } from '../session-manager.js';
import {
  getIndexedSessionIds,
  getEmbeddingGapStats,
  getUnembeddedMessages,
} from './message-store.js';
import { ingestSessionMessages, embedMessageBatch } from './message-ingest.js';
import { ensureModel, ensureBinary } from './embedder.js';
import { pushRosieLog } from '../rosie/debug-log.js';
import { getSettingsSnapshot, onSettingsChanged } from '../settings/index.js';
import type { RecallCatchupEvent } from '../channel-events.js';

// ============================================================================
// Types
// ============================================================================

// Re-export browser-safe types/constants so host-side consumers can import
// from this module (webview consumers should import from catchup-types.ts).
export type { CatchupStatus } from './catchup-types.js';
export { RECALL_CATCHUP_CHANNEL_ID } from './catchup-types.js';

import type { CatchupStatus } from './catchup-types.js';

export interface CatchupSubscriber {
  readonly id: string;
  send(event: RecallCatchupEvent): void;
}

/** Gap threshold: embed silently below this, prompt above. */
const SILENT_EMBED_THRESHOLD = 200;

/** System free memory threshold (MB) — stop embedding if free RAM drops below this. */
const FREE_MEM_FLOOR_MB = 1024;

/** Rough estimate: seconds per message for embedding with llama.cpp.
 * Server mode processes ~300-350 msg/min (~0.2s each); one-shot is ~3-5x
 * slower but only used for tiny batches. Use server-mode rate for initial
 * estimates since any large backfill triggers the server. */
const SECONDS_PER_MESSAGE = 0.2;

// ============================================================================
// Module State
// ============================================================================

const subscribers = new Map<string, CatchupSubscriber>();

let status: CatchupStatus = {
  phase: 'idle',
  gapCount: 0,
  totalMessages: 0,
  embeddedSoFar: 0,
  estimatedSecondsRemaining: 0,
};

/** Which host environment we're running in (set by startRecallCatchup). */
let hostType: 'vscode' | 'devServer' = 'devServer';

/** Cancellation flag for embedding backfill. */
let cancelRequested = false;

/** Whether a catch-up run is currently in progress. */
let running = false;

/** Unsubscribe from settings changes. */
let settingsUnsub: (() => void) | null = null;

// ============================================================================
// Pub/Sub (follows debug-log.ts pattern)
// ============================================================================

function broadcast(update: Partial<CatchupStatus>): void {
  Object.assign(status, update);
  const event: RecallCatchupEvent = {
    type: 'notification',
    kind: 'recall-catchup',
    status: { ...status },
  };
  for (const sub of subscribers.values()) {
    sub.send(event);
  }
}

/** Subscribe to catch-up status events. Sends current status immediately. */
export function subscribeCatchup(sub: CatchupSubscriber): void {
  subscribers.set(sub.id, sub);
  // Send current status immediately (like debug-log snapshot)
  sub.send({
    type: 'notification',
    kind: 'recall-catchup',
    status: { ...status },
  });
}

/** Unsubscribe from catch-up status events. */
export function unsubscribeCatchup(subId: string): void {
  subscribers.delete(subId);
}

// ============================================================================
// Settings Helpers
// ============================================================================

/** Check if recall is enabled for the current host environment. */
function isRecallEnabled(): boolean {
  try {
    const snapshot = getSettingsSnapshot();
    const mcpMem = snapshot.settings.mcp?.memory;
    if (!mcpMem) return true; // default ON
    return mcpMem[hostType] !== false;
  } catch {
    // Settings not initialized yet — defer; the settings-change listener
    // will trigger catch-up once settings load.
    return false;
  }
}

// ============================================================================
// FTS5 Catch-up
// ============================================================================

async function runFts5Catchup(): Promise<void> {
  broadcast({ phase: 'fts5-indexing' });

  const sessions = listAllSessions();
  const alreadyIndexed = getIndexedSessionIds();
  let indexed = 0;

  let processed = 0;
  for (const s of sessions) {
    if (cancelRequested) return;
    if (s.isSidechain) continue;
    if (alreadyIndexed.has(s.sessionId)) continue;
    if (!existsSync(s.path)) continue;

    try {
      const result = await ingestSessionMessages(s.sessionId);
      if (!result.skipped && !result.error) {
        indexed += result.chunksCreated;
      }
    } catch {
      // Non-fatal — skip and continue
    }

    // Yield to the event loop every 10 sessions to avoid starving Cursor's
    // extension host — without this, ingesting 1,900+ sessions on a fresh DB
    // blocks the main thread long enough to trigger a crash.
    if (++processed % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (indexed > 0) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: `FTS5 catch-up: ${indexed} messages indexed`,
    });
  }
}

// ============================================================================
// Embedding Backfill
// ============================================================================

/** Batch size for cross-session catch-up embedding. Each batch spawns one
 *  llama-embedding process, amortizing the ~2-5s model load across more messages.
 *  Safe at 80 because MAX_EMBED_CHARS (14K) caps each message to ~7,400 tokens
 *  worst case, well under llama-embedding's 8192 per-text context limit. */
const CATCHUP_BATCH_SIZE = 80;

/** Stop embedding after this many consecutive batch failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Check system free memory and return true if we should stop. */
function memoryPressure(): boolean {
  const freeMB = Math.round(freemem() / 1024 / 1024);
  const under = freeMB < FREE_MEM_FLOOR_MB;
  if (under) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Memory pressure: ${freeMB} MB free < ${FREE_MEM_FLOOR_MB} MB floor`,
    });
  }
  return under;
}

/**
 * Run embedding backfill on unvectorized messages across all sessions.
 *
 * Fetches messages cross-session (newest first) in batches of CATCHUP_BATCH_SIZE,
 * embedding each batch in a single llama-embedding process spawn. Stops on
 * cancellation, memory pressure, or MAX_CONSECUTIVE_FAILURES repeated failures.
 */
async function runEmbedding(): Promise<void> {
  // Download binary + model if needed
  broadcast({ phase: 'downloading-model', stoppedByMemoryPressure: false, stoppedByError: undefined });
  try {
    await ensureBinary();
  } catch (err) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Binary download failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    broadcast({ phase: 'done', gapCount: status.gapCount });
    return;
  }
  try {
    await ensureModel();
  } catch (err) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Model download failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    broadcast({ phase: 'done', gapCount: status.gapCount });
    return;
  }

  broadcast({ phase: 'embedding', embeddedSoFar: 0 });

  let totalEmbedded = 0;
  let consecutiveFailures = 0;
  const embedStartTime = Date.now();

  while (!cancelRequested && !memoryPressure()) {
    // Fetch 2 batches worth of messages, split into concurrent work
    const allMessages = getUnembeddedMessages(CATCHUP_BATCH_SIZE * 2);
    if (allMessages.length === 0) break;

    // Split into up to 2 batches for concurrent processing
    const batches: Array<typeof allMessages> = [];
    for (let i = 0; i < allMessages.length; i += CATCHUP_BATCH_SIZE) {
      batches.push(allMessages.slice(i, i + CATCHUP_BATCH_SIZE));
    }

    try {
      const results = await Promise.all(batches.map(b => embedMessageBatch(b)));
      const batchTotal = results.reduce((sum, n) => sum + n, 0);
      totalEmbedded += batchTotal;
      consecutiveFailures = 0;

      // Update progress
      const elapsed = (Date.now() - embedStartTime) / 1000;
      const rate = totalEmbedded / elapsed;
      const remaining = status.gapCount - totalEmbedded;
      const estSeconds = rate > 0 ? Math.round(remaining / rate) : 0;
      broadcast({
        embeddedSoFar: totalEmbedded,
        estimatedSecondsRemaining: Math.max(0, estSeconds),
      });
    } catch (err) {
      consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      pushRosieLog({
        source: 'recall-catchup',
        level: 'warn',
        summary: `Embed batch failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${msg}`,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        pushRosieLog({
          source: 'recall-catchup',
          level: 'warn',
          summary: `Embedding stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
        });
        broadcast({ stoppedByError: 'Embedding failed repeatedly — check logs for details' });
        break;
      }
    }
  }

  // Flag memory pressure if that's why we stopped
  if (!cancelRequested && memoryPressure()) {
    broadcast({ stoppedByMemoryPressure: true });
  }

  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: `runEmbedding complete — ${totalEmbedded} messages vectorized`,
    data: { totalEmbedded, cancelled: cancelRequested },
  });

  // Re-detect gap after backfill
  const { gapCount, totalMessages } = getEmbeddingGapStats();
  broadcast({ phase: 'done', gapCount, totalMessages, estimatedSecondsRemaining: 0 });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run on activation — call unconditionally (matches initRecallIngest pattern).
 * Internally checks recall setting before doing any work.
 *
 * @param host  Which host environment ('vscode' | 'devServer'). Defaults to 'devServer'.
 */
export async function startRecallCatchup(
  host?: 'vscode' | 'devServer',
): Promise<void> {
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'startRecallCatchup called',
    data: { host: host ?? 'devServer' },
  });
  if (host) hostType = host;
  // Subscribe to settings changes to detect recall toggle
  if (!settingsUnsub) {
    settingsUnsub = onSettingsChanged(({ changedSections }) => {
      if (!changedSections.includes('mcp')) return;

      if (isRecallEnabled()) {
        // Recall toggled ON — trigger catch-up if not already running
        if (!running) {
          runCatchup().catch(err => {
            console.warn('[recall-catchup] catch-up failed:', err);
          });
        }
      } else {
        // Recall toggled OFF — stop any in-progress backfill
        stopEmbeddingBackfill();
      }
    });
  }

  // Don't start if recall is disabled
  if (!isRecallEnabled()) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: 'Recall disabled — skipping catch-up',
      data: { hostType },
    });
    return;
  }

  await runCatchup();
}

/** Internal: run the full catch-up pipeline. */
async function runCatchup(): Promise<void> {
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'runCatchup called',
  });
  if (running) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: 'runCatchup blocked — already running',
    });
    return;
  }
  running = true;
  cancelRequested = false;

  try {
    // Phase 1: FTS5 catch-up (fast, silent)
    await runFts5Catchup();

    if (cancelRequested) return;

    // Phase 2: Gap detection
    const { gapCount, totalMessages } = getEmbeddingGapStats();
    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'Gap detection complete',
      data: { gapCount, totalMessages },
    });
    broadcast({
      phase: 'detecting-gap',
      gapCount,
      totalMessages,
      estimatedSecondsRemaining: gapCount * SECONDS_PER_MESSAGE,
    });

    if (gapCount === 0) {
      pushRosieLog({
        source: 'recall-catchup',
        level: 'info',
        summary: 'No embedding gap — nothing to do',
      });
      broadcast({ phase: 'done' });
      return;
    }

    // Phase 3: Decision — silent embed or prompt
    if (gapCount <= SILENT_EMBED_THRESHOLD) {
      pushRosieLog({
        source: 'recall-catchup',
        level: 'info',
        summary: `Small gap (${gapCount}) — embedding silently`,
      });
      // Small gap — embed silently
      await runEmbedding();
    } else {
      pushRosieLog({
        source: 'recall-catchup',
        level: 'info',
        summary: `Large gap (${gapCount}) — prompting user`,
      });
      // Large gap — broadcast status and wait for user action.
      // The webview will show the lightbox prompt.
      // phase stays at 'detecting-gap' with the gapCount set.
    }
  } catch (err) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Catch-up failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    running = false;
  }
}

/** User clicked "Start Embedding" — begin background backfill. */
export async function startEmbeddingBackfill(): Promise<void> {
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'startEmbeddingBackfill called',
  });
  if (running) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: 'startEmbeddingBackfill blocked — already running',
    });
    return;
  }
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'Embedding backfill starting',
  });
  running = true;
  cancelRequested = false;

  try {
    await runEmbedding();
  } catch (err) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Embedding backfill failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    // Broadcast done with current gap so the UI doesn't get stuck
    const { gapCount, totalMessages } = getEmbeddingGapStats();
    broadcast({ phase: 'done', gapCount, totalMessages });
  } finally {
    running = false;
  }
}

/** User clicked "Stop" — cancel in-progress backfill. */
export function stopEmbeddingBackfill(): void {
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'stopEmbeddingBackfill called — cancel requested',
  });
  cancelRequested = true;
}

/** Current catch-up status for the webview. */
export function getCatchupStatus(): CatchupStatus {
  return { ...status };
}
