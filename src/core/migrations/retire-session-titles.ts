/**
 * Async data migration: drain `pending_title_migration` into vendor stores.
 *
 * The schema migration (crispy-db.ts v5→v6) is sync and always succeeds —
 * it stages legacy `session_titles.title` values into the
 * `pending_title_migration` table. This module runs after adapter
 * registration is complete and pushes those titles through the new
 * vendor-native rename path (Claude SDK, Codex `thread/name/set`).
 *
 * Idempotent: rows that succeed are deleted; rows that fail get retried
 * on the next startup with a hard cap of 5 attempts. Empty
 * `pending_title_migration` is the completion marker.
 *
 * Read-side already handles partial migration — the cascade no longer
 * reads `title`, so sessions with pending rows just display via their
 * `aiTitle` / `lastUserPrompt` fallback until backfill succeeds.
 *
 * @module migrations/retire-session-titles
 */

import { getDb } from '../crispy-db.js';
import { dbPath } from '../paths.js';
import { log } from '../log.js';
import { getDiscoveries, setSessionTitle, getSessionTitle } from '../session-manager.js';

const MAX_ATTEMPTS = 5;

interface PendingRow {
  session_id: string;
  title: string;
  attempts: number;
}

/**
 * Drain `pending_title_migration` into vendor stores.
 * Safe to call at any time after adapter registration; concurrent calls
 * are not strictly serialized but the per-row outcomes are independent
 * (each row is delete-on-success / increment-on-fail).
 */
export async function runPendingTitleMigration(): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  capped: number;
  skippedNonClobber: number;
}> {
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let capped = 0;
  let skippedNonClobber = 0;

  const db = getDb(dbPath());
  let rows: PendingRow[];
  try {
    rows = db.all('SELECT session_id, title, attempts FROM pending_title_migration') as unknown as PendingRow[];
  } catch (err) {
    log({
      level: 'warn',
      source: 'title-migration',
      summary: `Could not read pending_title_migration: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { attempted, succeeded, failed, capped, skippedNonClobber };
  }

  if (rows.length === 0) return { attempted, succeeded, failed, capped, skippedNonClobber };

  log({
    source: 'title-migration',
    level: 'info',
    summary: `Title migration: ${rows.length} pending row(s) to backfill`,
  });

  // Warm vendor caches so resolveTitleHandler / getSessionTitle can resolve
  // sessions whose discovery hasn't been touched yet (Codex on first startup
  // has an empty sessionCache — without this, every Codex pending row
  // increments attempts and gets permanently abandoned after MAX_ATTEMPTS).
  await Promise.allSettled(
    getDiscoveries().map((d) => d.refresh?.()),
  );

  for (const row of rows) {
    attempted++;

    if (row.attempts >= MAX_ATTEMPTS) {
      // Permanently abandon — delete and log a warning.
      try {
        db.run('DELETE FROM pending_title_migration WHERE session_id = ?', [row.session_id]);
      } catch {
        // ignore
      }
      capped++;
      log({
        level: 'warn',
        source: 'title-migration',
        summary: `Title migration: abandoning ${row.session_id.slice(0, 12)}… after ${row.attempts} attempts`,
      });
      continue;
    }

    // Don't-clobber check: if the vendor already has a fresher title (user
    // renamed via the new UI between startup and now), drop the pending
    // row without writing.
    try {
      const current = await getSessionTitle(row.session_id);
      if (current && current.trim() && current.trim() !== row.title.trim()) {
        try {
          db.run('DELETE FROM pending_title_migration WHERE session_id = ?', [row.session_id]);
        } catch {
          // ignore
        }
        skippedNonClobber++;
        log({
          source: 'title-migration',
          level: 'info',
          summary: `Title migration: vendor has fresher title for ${row.session_id.slice(0, 12)}… — dropping pending row`,
        });
        continue;
      }
    } catch {
      // Read failed (vendor offline, unknown session) — treat like a write
      // failure below so the row stays for retry. Fall through.
    }

    try {
      await setSessionTitle(row.session_id, row.title);
      try {
        db.run('DELETE FROM pending_title_migration WHERE session_id = ?', [row.session_id]);
      } catch {
        // ignore
      }
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        db.run(
          'UPDATE pending_title_migration SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE session_id = ?',
          [msg.slice(0, 500), new Date().toISOString(), row.session_id],
        );
      } catch {
        // ignore
      }
      failed++;
      log({
        level: 'debug',
        source: 'title-migration',
        summary: `Title migration: ${row.session_id.slice(0, 12)}… failed (attempt ${row.attempts + 1}/${MAX_ATTEMPTS}): ${msg}`,
      });
    }
  }

  log({
    source: 'title-migration',
    level: 'info',
    summary: `Title migration: ${succeeded} succeeded, ${failed} failed, ${capped} capped, ${skippedNonClobber} skipped (vendor fresher)`,
    data: { attempted, succeeded, failed, capped, skippedNonClobber },
  });

  return { attempted, succeeded, failed, capped, skippedNonClobber };
}
