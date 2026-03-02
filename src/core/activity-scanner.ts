/**
 * Activity Scanner — Orchestrator for User Activity Indexing
 *
 * Scans all registered vendor sessions, extracts user prompts via
 * scanUserActivity(), and appends results to the activity index.
 * Tracks per-file scan progress to enable incremental scanning.
 *
 * Design:
 * - Single exported function runScan() called on startup + 30s interval
 * - Per-file error isolation (one failure doesn't abort the batch)
 * - Truncation detection: if file shrinks, reset offset and re-scan
 * - Vendors without scanUserActivity() are gracefully skipped
 *
 * @module activity-scanner
 */

import * as fs from 'node:fs';
import { getDiscovery, listAllSessions } from './session-manager.js';
import {
  loadScanState,
  saveScanState,
  appendActivityEntries,
  type ActivityIndexEntry,
} from './activity-index.js';

/**
 * Run a full scan of all registered vendor sessions.
 *
 * 1. Load current scan state from disk
 * 2. Get all sessions from all registered adapters
 * 3. For each session file:
 *    - Skip if unchanged (same mtime + size)
 *    - Reset offset if truncated (size < cached)
 *    - Call vendor's scanUserActivity() from saved offset
 *    - Append new prompts to activity index
 *    - Update scan state
 * 4. Save scan state to disk (atomic write)
 *
 * Error isolation: a single file failure is logged but doesn't abort
 * the batch. Other files continue to be scanned.
 */
export function runScan(): void {
  const state = loadScanState();
  const sessions = listAllSessions();
  const newEntries: ActivityIndexEntry[] = [];
  let stateChanged = false;

  for (const session of sessions) {
    // Skip sessions without a path (e.g., RPC-only Codex sessions)
    if (!session.path) continue;

    try {
      const stat = fs.statSync(session.path);
      const cached = state.files[session.path];
      const mtime = stat.mtimeMs;
      const size = stat.size;

      // Skip if unchanged (same mtime + size)
      if (cached && cached.mtime === mtime && cached.size === size) {
        continue;
      }

      // Reset offset if file was truncated (size < cached)
      let fromOffset = cached?.offset ?? 0;
      if (cached && size < cached.size) {
        fromOffset = 0;
      }

      // Call vendor scanner
      const discovery = getDiscovery(session.vendor);
      const result = discovery?.scanUserActivity?.(session.path, fromOffset);

      if (result) {
        // Convert UserPromptInfo to ActivityIndexEntry
        for (const prompt of result.prompts) {
          newEntries.push({
            timestamp: prompt.timestamp,
            kind: 'prompt',
            file: session.path,
            preview: prompt.preview,
            offset: prompt.offset,
            uuid: prompt.uuid,
          });
        }

        // Update scan state with new offset
        state.files[session.path] = { mtime, size, offset: result.offset };
      } else {
        // Vendor doesn't support scanning — record mtime/size to skip next time
        state.files[session.path] = { mtime, size, offset: 0 };
      }

      stateChanged = true;
    } catch (err) {
      // Per-file error isolation — log and continue
      console.error(`[activity-scanner] Error scanning ${session.path}:`, err);
    }
  }

  // Append new entries to activity index
  if (newEntries.length > 0) {
    appendActivityEntries(newEntries);
  }

  // Persist scan state (atomic write)
  if (stateChanged) {
    saveScanState(state);
  }
}
