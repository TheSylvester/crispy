/**
 * Rosie Tracker DB Writer — UPSERT logic for projects, sessions, and files
 *
 * Writes validated TrackerBlocks to the projects/project_sessions/project_files
 * tables. All writes in a single transaction. New projects get a random UUID;
 * existing projects are updated in place.
 *
 * Also provides getExistingProjects() for building prompt context, and
 * runDedupSweep() for post-write duplicate detection and merging.
 *
 * @module rosie/tracker/db-writer
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../crispy-db.js';
import { ensureCrispyDir, dbPath } from '../../activity-index.js';
import { pushRosieLog } from '../debug-log.js';
import { parseModelOption } from '../../model-utils.js';
import { getSettingsSnapshotInternal } from '../../settings/index.js';
import type { AgentDispatch } from '../../../host/agent-dispatch.js';
import type { TrackerBlock } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

let dirEnsured = false;

/**
 * Get the shared DB singleton via the canonical dbPath() from activity-index.
 * Ensures ~/.crispy/ exists on first call only — subsequent calls skip the
 * synchronous mkdirSync.
 */
function getTrackerDb() {
  if (!dirEnsured) {
    ensureCrispyDir();
    dirEnsured = true;
  }
  return getDb(dbPath());
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Write validated tracker blocks to the database.
 *
 * All writes in a single transaction. For each block:
 * - Empty id → INSERT new project with generated UUID
 * - Non-empty id → UPDATE existing project
 * - UPSERT project_sessions and project_files
 */
export function writeTrackerResults(blocks: TrackerBlock[], sessionFile: string): void {
  if (blocks.length === 0) return;

  const db = getTrackerDb();
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const insertProject = db.prepare(
      `INSERT INTO projects (id, title, status, blocked_by, summary, branch, entities, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateProject = db.prepare(
      `UPDATE projects SET
         title = ?, status = ?, blocked_by = ?, summary = ?,
         branch = ?, entities = ?, updated_at = ?, last_activity_at = ?,
         closed_at = CASE WHEN ? IN ('done', 'abandoned') THEN ? ELSE closed_at END
       WHERE id = ?`,
    );
    const upsertSession = db.prepare(
      `INSERT OR IGNORE INTO project_sessions (project_id, session_file, detected_in, linked_at)
       VALUES (?, ?, ?, ?)`,
    );
    const upsertFile = db.prepare(
      `INSERT OR REPLACE INTO project_files (project_id, file_path, session_file, note, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    try {
      for (const block of blocks) {
        const p = block.project;
        let projectId: string;

        if (!p.id) {
          // New project
          projectId = randomUUID();
          insertProject.run([
            projectId, p.title, p.status, p.blocked_by || null, p.summary || null,
            p.branch || null, p.entities || '[]',
            now, now, now,
          ]);
        } else {
          // Update existing project
          projectId = p.id;
          updateProject.run([
            p.title, p.status, p.blocked_by || null, p.summary || null,
            p.branch || null, p.entities || '[]', now, now,
            p.status, now, // for the CASE WHEN closed_at
            projectId,
          ]);
        }

        // Link session
        upsertSession.run([
          projectId, sessionFile, block.sessionRef.detected_in || null, now,
        ]);

        // Link files
        for (const f of block.files) {
          upsertFile.run([projectId, f.path, sessionFile, f.note || null, now]);
        }
      }
    } finally {
      insertProject.finalize();
      updateProject.finalize();
      upsertSession.finalize();
      upsertFile.finalize();
    }

    db.exec('COMMIT');
    pushRosieLog({ source: 'db', level: 'info', summary: `Tracker DB: wrote ${blocks.length} projects`, data: { count: blocks.length } });
  } catch (e) {
    db.exec('ROLLBACK');
    pushRosieLog({ source: 'db', level: 'error', summary: `Tracker DB: rollback — ${e instanceof Error ? e.message : String(e)}`, data: { error: String(e) } });
    throw e;
  }
}

/**
 * Record the outcome of a tracker analysis attempt.
 *
 * Called after successful tool calls (tracked/trivial) or after all retries
 * exhausted (failed). Uses INSERT OR REPLACE so re-runs overwrite prior results.
 */
export function recordTrackerOutcome(
  sessionFile: string,
  outcome: 'tracked' | 'trivial' | 'failed',
  attempts: number,
  reason?: string,
): void {
  try {
    const db = getTrackerDb();
    db.run(
      `INSERT OR REPLACE INTO tracker_outcomes (session_file, outcome, reason, attempts, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [sessionFile, outcome, reason ?? null, attempts],
    );
  } catch (err) {
    console.warn('[rosie.tracker] Failed to record outcome:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Get all non-abandoned projects for prompt context and validation.
 */
export function getExistingProjects(): { id: string; title: string; status: string; entities: string }[] {
  try {
    const db = getTrackerDb();
    const rows = db.all(
      `SELECT id, title, status, entities FROM projects WHERE status != 'abandoned' ORDER BY updated_at DESC`,
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        status: row.status as string,
        entities: (row.entities as string) ?? '[]',
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Dedup — Two-stage duplicate project detection and merging
// ============================================================================

/** Full project row for dedup comparisons. */
interface ProjectRow {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  entities: string;
  created_at: string;
  updated_at: string;
}

/** A candidate duplicate pair with the reason it was flagged. */
export interface DupCandidate {
  a: ProjectRow;
  b: ProjectRow;
  reason: string;
  jaccard: number;
  levenshtein: number;
}

/** Module-level guard — prevents concurrent dedup runs. */
let dedupInFlight = false;

/** Stage 1 thresholds — either crossing its threshold flags a candidate pair. */
const CANDIDATE_JACCARD_THRESHOLD = 0.5;
const CANDIDATE_LEVENSHTEIN_THRESHOLD = 0.3;

// ============================================================================
// Stage 1: Heuristic helpers (pure functions, exported for testing)
// ============================================================================

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|.
 * Returns 0 for empty sets.
 */
export function computeJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Normalized Levenshtein distance: editDistance(a, b) / max(|a|, |b|).
 * Returns 0 for identical strings, 1 for completely different strings.
 * Uses Wagner-Fischer algorithm — O(n*m) is fine for short project titles.
 */
export function normalizedLevenshtein(a: string, b: string): number {
  // Normalize: lowercase, strip punctuation
  const na = a.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const nb = b.toLowerCase().replace(/[^\w\s]/g, '').trim();

  if (na === nb) return 0;
  if (na.length === 0 || nb.length === 0) return 1;

  // Wagner-Fischer
  const m = na.length;
  const n = nb.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      if (na[i - 1] === nb[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      }
      prev = tmp;
    }
  }

  return dp[n]! / Math.max(m, n);
}

/**
 * Parse a JSON entity array string safely.
 * Returns an empty array for invalid/missing input.
 */
function parseEntities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Find candidate duplicate pairs among projects using heuristic signals.
 *
 * Either signal crossing its threshold produces a candidate:
 * - Entity Jaccard ≥ 0.5
 * - Title Levenshtein ≤ 0.3 (70%+ similarity)
 */
export function findDupeCandidates(projects: ProjectRow[]): DupCandidate[] {
  const candidates: DupCandidate[] = [];

  // Pre-parse entities once per project (avoids O(n²) re-parsing)
  const parsedEntities = projects.map((p) => parseEntities(p.entities));

  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i]!;
      const b = projects[j]!;

      // Never compare a project against itself
      if (a.id === b.id) continue;

      const entitiesA = parsedEntities[i]!;
      const entitiesB = parsedEntities[j]!;

      // Compute entity overlap (skip if both have no entities)
      const jaccard = (entitiesA.length > 0 && entitiesB.length > 0)
        ? computeJaccard(entitiesA, entitiesB)
        : 0;

      // Compute title similarity
      const lev = normalizedLevenshtein(a.title, b.title);

      const entityMatch = jaccard >= CANDIDATE_JACCARD_THRESHOLD;
      const titleMatch = lev <= CANDIDATE_LEVENSHTEIN_THRESHOLD;

      if (entityMatch || titleMatch) {
        const reasons: string[] = [];
        if (entityMatch) reasons.push(`entity-jaccard=${jaccard.toFixed(2)}`);
        if (titleMatch) reasons.push(`title-levenshtein=${lev.toFixed(2)}`);
        candidates.push({ a, b, reason: reasons.join(', '), jaccard, levenshtein: lev });
      }
    }
  }

  return candidates;
}

// ============================================================================
// Stage 2: Merge execution
// ============================================================================

/**
 * Merge two projects: keep one, delete the other.
 *
 * - Preserves the older created_at
 * - Unions entity arrays (deduplicated)
 * - Migrates all project_sessions rows to survivor
 * - Migrates project_files rows (skips on UNIQUE conflict)
 * - Deletes the stale project row
 */
export function mergeProjects(
  keepId: string,
  removeId: string,
  mergedTitle?: string,
  mergedSummary?: string,
): void {
  const db = getTrackerDb();

  db.exec('BEGIN');
  try {
    // Fetch both rows
    const keepRow = db.all(`SELECT * FROM projects WHERE id = ?`, [keepId])[0] as Record<string, unknown> | undefined;
    const removeRow = db.all(`SELECT * FROM projects WHERE id = ?`, [removeId])[0] as Record<string, unknown> | undefined;

    if (!keepRow || !removeRow) {
      db.exec('ROLLBACK');
      return;
    }

    // Preserve older created_at
    const keepCreated = keepRow.created_at as string;
    const removeCreated = removeRow.created_at as string;
    const earlierCreated = keepCreated < removeCreated ? keepCreated : removeCreated;

    // Union entities
    const keepEntities = parseEntities(keepRow.entities as string);
    const removeEntities = parseEntities(removeRow.entities as string);
    const unionedEntities = [...new Set([...keepEntities, ...removeEntities])];

    // Update the surviving project
    const title = mergedTitle || (keepRow.title as string);
    const summary = mergedSummary || (keepRow.summary as string);

    const updateSurvivor = db.prepare(
      `UPDATE projects SET title = ?, summary = ?, entities = ?, created_at = ?, updated_at = ? WHERE id = ?`,
    );
    const migrateSessions = db.prepare(
      `INSERT OR IGNORE INTO project_sessions (project_id, session_file, detected_in, linked_at)
       SELECT ?, session_file, detected_in, linked_at FROM project_sessions WHERE project_id = ?`,
    );
    const migrateFiles = db.prepare(
      `INSERT OR IGNORE INTO project_files (project_id, file_path, session_file, note, added_at)
       SELECT ?, file_path, session_file, note, added_at FROM project_files WHERE project_id = ?`,
    );
    const deleteSessions = db.prepare(`DELETE FROM project_sessions WHERE project_id = ?`);
    const deleteFiles = db.prepare(`DELETE FROM project_files WHERE project_id = ?`);
    const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);

    try {
      updateSurvivor.run([title, summary, JSON.stringify(unionedEntities), earlierCreated, new Date().toISOString(), keepId]);
      migrateSessions.run([keepId, removeId]);
      migrateFiles.run([keepId, removeId]);
      deleteSessions.run([removeId]);
      deleteFiles.run([removeId]);
      deleteProject.run([removeId]);
    } finally {
      updateSurvivor.finalize();
      migrateSessions.finalize();
      migrateFiles.finalize();
      deleteSessions.finalize();
      deleteFiles.finalize();
      deleteProject.finalize();
    }

    db.exec('COMMIT');

    pushRosieLog({
      source: 'tracker',
      level: 'info',
      summary: `Dedup: merged "${removeRow.title}" → "${title}" (kept ${keepId})`,
      data: { keepId, removeId, mergedTitle: title },
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ============================================================================
// Dedup Sweep — Orchestrates Stage 1 + Stage 2
// ============================================================================

/** High-confidence thresholds for auto-merge (skip LLM). */
const AUTO_MERGE_JACCARD = 0.7;
const AUTO_MERGE_LEVENSHTEIN = 0.2;

/**
 * Run the full dedup sweep: heuristic candidate detection + LLM adjudication.
 *
 * Auto-merges high-confidence duplicates (Jaccard ≥ 0.7 AND Levenshtein ≤ 0.2).
 * For ambiguous candidates, dispatches a Haiku child session for adjudication.
 *
 * Safe to call after every writeTrackerResults() — SQL + string math is cheap.
 * Idempotent — run it 100 times, same result.
 */
export async function runDedupSweep(
  dispatchChild: AgentDispatch['dispatchChild'],
): Promise<void> {
  // Concurrency guard
  if (dedupInFlight) return;
  dedupInFlight = true;

  try {
    // Load all non-abandoned projects with full data for comparison
    const db = getTrackerDb();
    const rows = db.all(
      `SELECT id, title, status, summary, entities, created_at, updated_at
       FROM projects WHERE status != 'abandoned' ORDER BY updated_at DESC`,
    );
    const projects: ProjectRow[] = rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        status: row.status as string,
        summary: (row.summary as string) ?? null,
        entities: (row.entities as string) ?? '[]',
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      };
    });

    if (projects.length < 2) return;

    const candidates = findDupeCandidates(projects);
    if (candidates.length === 0) return;

    console.log(`[rosie.dedup] Found ${candidates.length} candidate pair(s)`);

    // Track merged IDs so we don't try to merge already-removed projects
    const merged = new Set<string>();

    for (const candidate of candidates) {
      if (merged.has(candidate.a.id) || merged.has(candidate.b.id)) continue;

      const isHighConfidence =
        candidate.jaccard >= AUTO_MERGE_JACCARD &&
        candidate.levenshtein <= AUTO_MERGE_LEVENSHTEIN;

      if (isHighConfidence) {
        // Auto-merge: keep the one with more recent updated_at
        const keepProject = candidate.a.updated_at >= candidate.b.updated_at ? candidate.a : candidate.b;
        const removeProject = keepProject === candidate.a ? candidate.b : candidate.a;
        console.log(`[rosie.dedup] Auto-merge: "${removeProject.title}" → "${keepProject.title}" (${candidate.reason})`);
        mergeProjects(keepProject.id, removeProject.id);
        merged.add(removeProject.id);
      } else {
        // Ambiguous — ask LLM
        const verdict = await askLlmVerdict(dispatchChild, candidate);
        if (verdict) {
          mergeProjects(verdict.keepId, verdict.removeId, verdict.mergedTitle, verdict.mergedSummary);
          merged.add(verdict.removeId);
        }
      }
    }

    if (merged.size > 0) {
      console.log(`[rosie.dedup] Sweep complete — merged ${merged.size} duplicate(s)`);
    }
  } catch (err) {
    console.warn('[rosie.dedup] Sweep failed:', err instanceof Error ? err.message : String(err));
    pushRosieLog({
      source: 'tracker',
      level: 'error',
      summary: `Dedup sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      data: { error: String(err) },
    });
  } finally {
    dedupInFlight = false;
  }
}

// ============================================================================
// Stage 2: LLM Adjudication
// ============================================================================

interface MergeVerdict {
  keepId: string;
  removeId: string;
  mergedTitle?: string;
  mergedSummary?: string;
}

/**
 * Ask Haiku whether two projects are duplicates.
 * Returns merge instructions if confirmed, null if distinct.
 * Uses text verdict parsing (no MCP tool needed).
 */
async function askLlmVerdict(
  dispatchChild: AgentDispatch['dispatchChild'],
  candidate: DupCandidate,
): Promise<MergeVerdict | null> {
  const { a, b } = candidate;

  const prompt = `You are a dedup adjudicator. Decide whether these two projects are actually the same project tracked under different names.

## Project A
- ID: ${a.id}
- Title: ${a.title}
- Summary: ${a.summary ?? '(none)'}
- Entities: ${a.entities}

## Project B
- ID: ${b.id}
- Title: ${b.title}
- Summary: ${b.summary ?? '(none)'}
- Entities: ${b.entities}

## Flagged because
${candidate.reason}

## Instructions
If these are the SAME project (same goal, same work), respond with EXACTLY:
MERGE keep=<id-to-keep> remove=<id-to-remove>

Optionally add on the next lines:
title=<better title if neither is ideal>
summary=<merged summary if helpful>

If these are DISTINCT projects (different goals despite overlap), respond with EXACTLY:
DISTINCT

Nothing else. No commentary.`;

  try {
    const snap = getSettingsSnapshotInternal();
    const rosieModel = snap.settings.rosie.tracker.model;
    const parsed = rosieModel ? parseModelOption(rosieModel) : undefined;

    const result = await dispatchChild({
      parentSessionId: `dedup-${randomUUID()}`,
      vendor: parsed?.vendor ?? 'claude',
      parentVendor: 'claude',
      prompt,
      settings: {
        ...(parsed?.model && { model: parsed.model }),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
      forceNew: true,
      env: {
        CLAUDECODE: '',
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
      },
      skipPersistSession: true,
      autoClose: true,
      timeoutMs: 15_000,
    });

    if (!result?.text) return null;

    return parseVerdict(result.text, a.id, b.id);
  } catch (err) {
    console.warn('[rosie.dedup] LLM adjudication failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Parse the LLM text verdict into a MergeVerdict or null.
 * Exported for testing.
 */
export function parseVerdict(text: string, idA: string, idB: string): MergeVerdict | null {
  if (!text || !text.trim()) return null;

  const lines = text.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  if (lines[0] === 'DISTINCT') return null;

  const mergeMatch = lines[0]!.match(/^MERGE\s+keep=(\S+)\s+remove=(\S+)$/);
  if (!mergeMatch) return null;

  const keepId = mergeMatch[1]!;
  const removeId = mergeMatch[2]!;

  // Validate the IDs match the candidate pair
  const validIds = new Set([idA, idB]);
  if (!validIds.has(keepId) || !validIds.has(removeId) || keepId === removeId) return null;

  const verdict: MergeVerdict = { keepId, removeId };

  // Parse optional title and summary lines
  for (const line of lines.slice(1)) {
    const titleMatch = line.match(/^title=(.+)$/);
    if (titleMatch) verdict.mergedTitle = titleMatch[1]!.trim();
    const summaryMatch = line.match(/^summary=(.+)$/);
    if (summaryMatch) verdict.mergedSummary = summaryMatch[1]!.trim();
  }

  return verdict;
}
