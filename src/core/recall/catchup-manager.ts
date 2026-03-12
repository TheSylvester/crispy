/**
 * Recall Catch-up Manager — FTS5 catch-up + embedding backfill orchestration
 *
 * Runs on activation to bring the recall index up to date:
 *   1. FTS5 catch-up: silently indexes all unindexed sessions (fast)
 *   2. Gap detection: counts messages without embedding vectors
 *   3. Embedding backfill: embeds unvectorized messages (slow, user-prompted if >200)
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
import { listAllSessions } from '../session-manager.js';
import {
  getIndexedSessionIds,
  getEmbeddingGapStats,
  getSessionsWithEmbeddingGap,
} from './message-store.js';
import { ingestSessionMessages, embedSessionMessages } from './message-ingest.js';
import { initEmbedWorker, shutdownEmbedWorker } from './embedder.js';
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

/** RSS threshold (MB) at which we stop embedding to avoid OOM. */
const RSS_LIMIT_MB = 1280;

/** Rough estimate: seconds per message for embedding on CPU ONNX. */
const SECONDS_PER_MESSAGE = 3;

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

/** Embed worker config — set by startRecallCatchup, used to init worker on-demand for backfill. */
let embedWorkerConfig: { scriptPath: string; tsx: boolean } | null = null;

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

/** Check RSS and return true if we should stop to avoid OOM. */
function memoryPressure(): boolean {
  const rss = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  return rss > RSS_LIMIT_MB;
}

/**
 * Run embedding backfill on sessions with unvectorized messages.
 *
 * Spins up the embed worker child process for the duration of the backfill
 * (isolates ONNX memory leaks), then shuts it down when done so the child
 * process doesn't linger and consume RAM.
 *
 * Real-time per-turn embedding (ingest-hook) uses in-process inference
 * instead — it never touches the worker.
 */
async function runEmbedding(): Promise<void> {
  broadcast({ phase: 'embedding', embeddedSoFar: 0 });

  const sessions = getSessionsWithEmbeddingGap();
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: `runEmbedding called — ${sessions.length} sessions with gap`,
  });
  if (sessions.length === 0) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'No sessions need embedding — done',
    });
    broadcast({ phase: 'done', gapCount: 0 });
    return;
  }

  // Spin up the worker for the backfill run
  if (embedWorkerConfig) {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'Initializing embed worker for backfill',
      data: { scriptPath: embedWorkerConfig.scriptPath, tsx: embedWorkerConfig.tsx },
    });
    initEmbedWorker(embedWorkerConfig.scriptPath, embedWorkerConfig.tsx);
  } else {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: 'No embedWorkerConfig — using in-process embedding',
    });
  }

  let totalEmbedded = 0;
  const embedStartTime = Date.now();

  try {
    for (const sessionId of sessions) {
      if (cancelRequested) break;

      // RSS watchdog — stop gracefully if memory is high
      if (memoryPressure()) {
        pushRosieLog({
          source: 'recall-catchup',
          level: 'warn',
          summary: 'Embedding stopped due to memory pressure — will resume on next activation',
        });
        break;
      }

      try {
        // Loop until the session is fully embedded (MAX_EMBED_BATCH caps each call)
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (cancelRequested || memoryPressure()) break;

          const count = await embedSessionMessages(sessionId);
          if (count === 0) break; // fully embedded

          totalEmbedded += count;

          // Update progress
          const elapsed = (Date.now() - embedStartTime) / 1000;
          const rate = totalEmbedded / elapsed; // messages per second
          const remaining = status.gapCount - totalEmbedded;
          const estSeconds = rate > 0 ? Math.round(remaining / rate) : 0;
          broadcast({
            embeddedSoFar: totalEmbedded,
            estimatedSecondsRemaining: Math.max(0, estSeconds),
          });
        }

      } catch (err) {
        pushRosieLog({
          source: 'recall-catchup',
          level: 'warn',
          summary: `Embed failed for session: ${err instanceof Error ? err.message : String(err)}`,
          data: { sessionId },
        });
        // Continue with next session — error recovery is incremental
      }
    }
  } finally {
    // Always shut down the worker after backfill — frees child process + all ONNX memory
    shutdownEmbedWorker();
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
 * @param workerConfig  Path + tsx flag for the embed worker child process.
 *                      The worker is only spawned during backfill, not at startup.
 */
export async function startRecallCatchup(
  host?: 'vscode' | 'devServer',
  workerConfig?: { scriptPath: string; tsx: boolean },
): Promise<void> {
  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'startRecallCatchup called',
    data: { host: host ?? 'devServer', hasWorkerConfig: !!workerConfig },
  });
  if (host) hostType = host;
  if (workerConfig) embedWorkerConfig = workerConfig;
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
