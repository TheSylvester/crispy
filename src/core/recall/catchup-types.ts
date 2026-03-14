/**
 * Recall Catch-up Types — Shared types and constants for catch-up status
 *
 * Browser-safe: no Node.js imports. Used by both the core catchup-manager
 * (Node) and the webview (browser) to share the channel ID and status type.
 *
 * @module recall/catchup-types
 */

/** Dedicated channel ID for catch-up status events. */
export const RECALL_CATCHUP_CHANNEL_ID = '__recall_catchup__';

export interface CatchupStatus {
  /** Phase of catch-up */
  phase: 'idle' | 'fts5-indexing' | 'detecting-gap' | 'downloading-model' | 'embedding' | 'done';
  /** Messages without vectors (0 = caught up) */
  gapCount: number;
  /** Total messages in FTS5 index */
  totalMessages: number;
  /** Messages embedded so far in current run */
  embeddedSoFar: number;
  /** Estimated time remaining in seconds (rough) */
  estimatedSecondsRemaining: number;
  /** True when last run stopped due to memory pressure */
  stoppedByMemoryPressure?: boolean;
  /** Set when embedding stopped after repeated failures */
  stoppedByError?: string;
}
