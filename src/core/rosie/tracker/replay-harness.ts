/**
 * Rosie Tracker Replay Harness — Offline testing tool
 *
 * Reads all rosie-meta entries from activity_entries, then replays them
 * through the tracker pipeline in chronological order: build prompt →
 * dispatchChild → parse → validate → write.
 *
 * Not wired to production. Run via dev console or standalone script.
 *
 * @module rosie/tracker/replay-harness
 */

import type { AgentDispatch } from '../../../host/agent-dispatch.js';
import { queryActivity } from '../../activity-index.js';
import { parseModelOption } from '../../model-utils.js';
import { parseTrackerResponse } from './xml-extractor.js';
import { validateTrackerBlocks } from './validator.js';
import { writeTrackerResults, getExistingProjects } from './db-writer.js';
import { buildTrackerPrompt } from './tracker-hook.js';

// ============================================================================
// Types
// ============================================================================

export interface ReplayStats {
  total: number;
  created: number;
  matched: number;
  skipped: number;
  errors: string[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Replay all rosie-meta entries through the tracker pipeline.
 *
 * Processes entries in chronological order. Each entry is treated as if
 * it just arrived from summarize — the tracker prompt is built with the
 * current state of the projects table (which grows as entries are processed).
 *
 * Writes to production `projects` tables.
 */
export async function replayTrackerFromHistory(
  d: AgentDispatch,
  options?: {
    /** Model override — "vendor:model" format. */
    model?: string;
    /** Vendor to use for dispatchChild. Defaults to 'claude'. */
    vendor?: string;
    /** If true, log each entry as it's processed. */
    verbose?: boolean;
  },
): Promise<ReplayStats> {
  const stats: ReplayStats = { total: 0, created: 0, matched: 0, skipped: 0, errors: [] };
  const entries = queryActivity(undefined, 'rosie-meta');

  if (entries.length === 0) {
    console.log('[replay-harness] No rosie-meta entries found');
    return stats;
  }

  console.log(`[replay-harness] Found ${entries.length} rosie-meta entries to replay`);

  const vendor = options?.vendor ?? 'claude';
  const parsed = options?.model ? parseModelOption(options.model) : undefined;
  const childVendor = parsed?.vendor ?? vendor;
  const childModel = parsed?.model;

  for (const entry of entries) {
    stats.total++;

    if (!entry.quest || !entry.summary) {
      stats.skipped++;
      if (options?.verbose) {
        console.log(`[replay-harness] Skipping entry ${stats.total}: missing quest/summary`);
      }
      continue;
    }

    try {
      // Build prompt with current project state (grows as we process entries)
      const existingProjects = getExistingProjects();
      const existingIds = new Set(existingProjects.map((p) => p.id));
      const prompt = buildTrackerPrompt(entry, existingProjects);

      if (options?.verbose) {
        console.log(`[replay-harness] Processing ${stats.total}/${entries.length}: ${entry.title ?? entry.quest}`);
      }

      const result = await d.dispatchChild({
        parentSessionId: 'replay-harness',
        vendor: childVendor,
        parentVendor: vendor,
        prompt,
        settings: {
          ...(childModel && { model: childModel }),
        },
        skipPersistSession: true,
        autoClose: true,
        timeoutMs: 30_000,
      });

      if (!result) {
        stats.skipped++;
        stats.errors.push(`Entry ${stats.total}: no response from child`);
        continue;
      }

      const blocks = parseTrackerResponse(result.text);
      if (blocks.length === 0) {
        stats.skipped++;
        if (options?.verbose) {
          console.log(`[replay-harness] No blocks parsed for entry ${stats.total}`);
        }
        continue;
      }

      const validation = validateTrackerBlocks(blocks, existingIds);
      if (validation.errors.length > 0) {
        stats.errors.push(...validation.errors.map((e) => `Entry ${stats.total}: ${e}`));
      }

      if (validation.valid.length > 0) {
        for (const block of validation.valid) {
          if (block.project.id) {
            stats.matched++;
          } else {
            stats.created++;
          }
        }
        writeTrackerResults(validation.valid, entry.file);
      }
    } catch (err) {
      stats.errors.push(`Entry ${stats.total}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[replay-harness] Complete: ${stats.total} total, ${stats.created} created, ${stats.matched} matched, ${stats.skipped} skipped, ${stats.errors.length} errors`);
  return stats;
}
