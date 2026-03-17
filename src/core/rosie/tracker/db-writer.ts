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
import { log } from '../../log.js';
import { parseModelOption } from '../../model-utils.js';
import { getSettingsSnapshotInternal } from '../../settings/index.js';
import type { AgentDispatch } from '../../../host/agent-dispatch.js';
import { VALID_STAGES } from './types.js';
import type { TrackerBlock, ProjectStage } from './types.js';

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
// Stage Queries
// ============================================================================

export interface StageRow {
  name: string;
  description: string;
  sortOrder: number;
  icon: string | null;
  color: string | null;
}

/** Hardcoded fallback when the stages table doesn't exist yet (pre-migration). */
const FALLBACK_STAGES: StageRow[] = [
  { name: 'active', description: 'Work is actively in progress', sortOrder: 0, icon: null, color: '#5cb870' },
  { name: 'paused', description: 'On hold — record reason in blocked_by', sortOrder: 1, icon: null, color: '#d4a030' },
  { name: 'planning', description: 'Being designed or specced out — not yet started', sortOrder: 2, icon: null, color: '#6878a0' },
  { name: 'ready', description: 'Ready to start — all prerequisites met', sortOrder: 3, icon: null, color: '#50a0d0' },
  { name: 'committed', description: 'Scheduled for implementation', sortOrder: 4, icon: null, color: '#a070c0' },
  { name: 'done', description: 'Work is complete — awaiting user review before archiving', sortOrder: 5, icon: null, color: '#22aa66' },
  { name: 'idea', description: 'A thought or suggestion discussed but not yet committed to', sortOrder: 6, icon: null, color: '#888898' },
  { name: 'archived', description: 'User-managed only. Do NOT move projects here', sortOrder: 7, icon: null, color: '#555568' },
];

/** Returns all stages ordered by sort_order. Falls back to hardcoded stages if DB isn't migrated. */
export function getStages(): StageRow[] {
  try {
    const db = getTrackerDb();
    const rows = db.all(`SELECT name, description, sort_order, icon, color FROM stages ORDER BY sort_order`);
    if (rows.length === 0) return FALLBACK_STAGES;
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        name: row.name as string,
        description: row.description as string,
        sortOrder: row.sort_order as number,
        icon: (row.icon as string) ?? null,
        color: (row.color as string) ?? null,
      };
    });
  } catch {
    return FALLBACK_STAGES;
  }
}

/** Returns multi-line `name: description` format for prompt injection. */
export function getStagesForPrompt(): string {
  const stages = getStages();
  if (stages.length === 0) return '';
  return stages.map((s) => `${s.name}: ${s.description}`).join('\n');
}

/** Returns stage name strings. Runtime replacement for VALID_STAGES. */
export function getValidStageNames(): string[] {
  const stages = getStages();
  if (stages.length === 0) {
    // Fallback to hardcoded constant if DB isn't migrated yet
    return [...VALID_STAGES];
  }
  return stages.map((s) => s.name);
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
  const tsNow = Date.now();

  db.exec('BEGIN');
  try {
    const insertProject = db.prepare(
      `INSERT INTO projects (id, title, stage, status, icon, blocked_by, summary, branch, entities, type, parent_id, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const readProject = db.prepare(
      `SELECT stage, status, entities FROM projects WHERE id = ?`,
    );
    const updateProject = db.prepare(
      `UPDATE projects SET
         title = COALESCE(?, title), stage = ?, status = ?, icon = COALESCE(?, icon),
         blocked_by = ?, summary = COALESCE(?, summary),
         branch = COALESCE(?, branch), entities = ?, updated_at = ?, last_activity_at = ?,
         closed_at = CASE WHEN ? IN ('archived', 'done') THEN ? ELSE closed_at END
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
    const insertActivity = db.prepare(
      `INSERT INTO project_activity (project_id, session_file, ts, kind, old_stage, new_stage, old_status, new_status, narrative, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      for (const block of blocks) {
        const p = block.project;
        let projectId: string;

        if (p.action === 'create') {
          // New project — use caller-supplied ID or generate one
          projectId = p.id || randomUUID();
          insertProject.run([
            projectId, p.title, p.stage, p.status || null, p.icon || null,
            p.blocked_by || null, p.summary || null,
            p.branch || null, p.entities || '[]',
            p.type || 'project', p.parent_id || null,
            now, now, now,
          ]);
          // Record 'created' activity
          insertActivity.run([projectId, sessionFile, tsNow, 'created', null, p.stage, null, p.status || null, null, 'rosie']);
        } else {
          // Track existing project — read current state, merge
          projectId = p.id;
          const existing = readProject.get([projectId]) as Record<string, unknown> | undefined;
          if (!existing) {
            log({ source: 'db', level: 'warn', summary: `Tracker DB: track skipped — project ${projectId} not found` });
            continue;
          }
          const oldStage = (existing.stage as string) ?? 'active';
          const oldStatus = (existing?.status as string) ?? null;
          const oldEntities = (existing?.entities as string) ?? '[]';

          // Merge entities additively
          let mergedEntities = oldEntities;
          if (p.entities) {
            try {
              const existingArr: string[] = JSON.parse(oldEntities);
              const newArr: string[] = JSON.parse(p.entities);
              mergedEntities = JSON.stringify([...new Set([...existingArr, ...newArr])]);
            } catch {
              mergedEntities = p.entities;
            }
          }

          const newStage = p.stage ?? oldStage;
          const newStatus = p.status ?? oldStatus;

          updateProject.run([
            null, // title — keep existing for track (no title field)
            newStage, newStatus, null, // icon — keep existing for track
            p.blocked_by ?? null, null, // summary — keep existing
            p.branch ?? null, mergedEntities, now, now,
            newStage, now, // for the CASE WHEN closed_at
            projectId,
          ]);

          // Record stage/status change activities
          if (p.stage && p.stage !== oldStage) {
            insertActivity.run([projectId, sessionFile, tsNow, 'stage_change', oldStage, newStage, null, null, null, 'rosie']);
          }
          if (p.status && p.status !== oldStatus) {
            insertActivity.run([projectId, sessionFile, tsNow, 'status_update', null, null, oldStatus, newStatus, null, 'rosie']);
          }
        }

        // Link session (INSERT OR IGNORE handles duplicates)
        upsertSession.run([
          projectId, sessionFile, block.sessionRef.detected_in || null, now,
        ]);

        // Link files (INSERT OR REPLACE handles duplicates)
        for (const f of block.files) {
          upsertFile.run([projectId, f.path, sessionFile, f.note || null, now]);
        }
      }
    } finally {
      insertProject.finalize();
      readProject.finalize();
      updateProject.finalize();
      upsertSession.finalize();
      upsertFile.finalize();
      insertActivity.finalize();
    }

    db.exec('COMMIT');
    log({ source: 'db', level: 'info', summary: `Tracker DB: wrote ${blocks.length} projects`, data: { count: blocks.length } });
  } catch (e) {
    db.exec('ROLLBACK');
    log({ source: 'db', level: 'error', summary: `Tracker DB: rollback — ${e instanceof Error ? e.message : String(e)}`, data: { error: String(e) } });
    throw e;
  }
}

// ============================================================================
// Activity & Stage Management
// ============================================================================

/** Record a single activity entry for a project. */
export function recordProjectActivity(entry: {
  projectId: string;
  sessionFile?: string;
  kind: string;
  oldStage?: string;
  newStage?: string;
  oldStatus?: string;
  newStatus?: string;
  narrative?: string;
  actor?: string;
}): void {
  const db = getTrackerDb();
  db.run(
    `INSERT INTO project_activity (project_id, session_file, ts, kind, old_stage, new_stage, old_status, new_status, narrative, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.projectId, entry.sessionFile ?? null, Date.now(), entry.kind,
     entry.oldStage ?? null, entry.newStage ?? null, entry.oldStatus ?? null, entry.newStatus ?? null,
     entry.narrative ?? null, entry.actor ?? 'rosie'],
  );
}

/** Look up a single project's title and icon by ID. Returns undefined if not found. */
export function getProjectTitle(projectId: string): { title?: string; icon?: string } | undefined {
  try {
    const db = getTrackerDb();
    const row = db.get(`SELECT title, icon FROM projects WHERE id = ?`, [projectId]) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      title: row.title as string | undefined,
      icon: (row.icon as string | undefined) ?? undefined,
    };
  } catch {
    return undefined;
  }
}

/** Update a project's stage (user-initiated drag-and-drop). Records activity. */
export function updateProjectStage(projectId: string, newStage: ProjectStage, actor = 'user'): void {
  const db = getTrackerDb();
  const row = db.get(`SELECT stage FROM projects WHERE id = ?`, [projectId]) as Record<string, unknown> | undefined;
  if (!row) return;
  const oldStage = row.stage as string;
  if (oldStage === newStage) return;

  const now = new Date().toISOString();
  db.run(
    `UPDATE projects SET stage = ?, sort_order = NULL, updated_at = ?, last_activity_at = ?,
       closed_at = CASE WHEN ? IN ('archived', 'done') THEN ? ELSE closed_at END
     WHERE id = ?`,
    [newStage, now, now, newStage, now, projectId],
  );
  recordProjectActivity({
    projectId, kind: 'stage_change', oldStage, newStage: newStage, actor,
  });
}

/** Update sort_order for a single project. */
export function updateProjectSortOrder(projectId: string, sortOrder: number): void {
  const db = getTrackerDb();
  db.run(`UPDATE projects SET sort_order = ? WHERE id = ?`, [sortOrder, projectId]);
}

/** Bulk-set sort_order for all projects in a stage group. */
export function reorderProjectsInStage(stage: string, orderedIds: string[]): void {
  const db = getTrackerDb();
  db.exec('BEGIN');
  try {
    const stmt = db.prepare(`UPDATE projects SET sort_order = ? WHERE id = ? AND stage = ?`);
    try {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run([i, orderedIds[i]!, stage]);
      }
    } finally {
      stmt.finalize();
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Get activity history for a project, optionally filtered by kind. */
export function getProjectActivity(
  projectId: string,
  opts?: { kind?: string },
): Array<{
  id: number; projectId: string; sessionFile: string | null; ts: number;
  kind: string; oldStage: string | null; newStage: string | null;
  oldStatus: string | null; newStatus: string | null;
  narrative: string | null; actor: string;
}> {
  const db = getTrackerDb();
  const sql = opts?.kind
    ? `SELECT * FROM project_activity WHERE project_id = ? AND kind = ? ORDER BY ts DESC LIMIT 200`
    : `SELECT * FROM project_activity WHERE project_id = ? ORDER BY ts DESC LIMIT 200`;
  const params = opts?.kind ? [projectId, opts.kind] : [projectId];
  const rows = db.all(sql, params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    projectId: r.project_id as string,
    sessionFile: (r.session_file as string) ?? null,
    ts: r.ts as number,
    kind: r.kind as string,
    oldStage: (r.old_stage as string) ?? null,
    newStage: (r.new_stage as string) ?? null,
    oldStatus: (r.old_status as string) ?? null,
    newStatus: (r.new_status as string) ?? null,
    narrative: (r.narrative as string) ?? null,
    actor: r.actor as string,
  }));
}

/**
 * Record the outcome of a Rosie subsystem invocation with optional token usage.
 *
 * Writes to `rosie_usage` (per-invocation rows) for both summarize and tracker.
 * Also writes to legacy `tracker_outcomes` for backward compatibility.
 */
export function recordTrackerOutcome(
  sessionFile: string,
  outcome: 'tracked' | 'trivial' | 'failed',
  attempts: number,
  reason?: string,
  opts?: {
    subsystem?: 'summarize' | 'tracker';
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    model?: string;
    costUsd?: number;
  },
): void {
  try {
    const db = getTrackerDb();

    // Write to new rosie_usage table (per-invocation)
    db.run(
      `INSERT INTO rosie_usage (session_file, subsystem, outcome, reason, input_tokens, output_tokens, cached_tokens, model, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionFile,
        opts?.subsystem ?? 'tracker',
        outcome,
        reason ?? null,
        opts?.inputTokens ?? null,
        opts?.outputTokens ?? null,
        opts?.cachedTokens ?? null,
        opts?.model ?? null,
        opts?.costUsd ?? null,
      ],
    );

    // Legacy: also write to tracker_outcomes for backward compatibility
    db.run(
      `INSERT OR REPLACE INTO tracker_outcomes (session_file, outcome, reason, attempts, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [sessionFile, outcome, reason ?? null, attempts],
    );
  } catch (err) {
    log({ level: 'warn', source: 'rosie.tracker', summary: `Failed to record outcome: ${err instanceof Error ? err.message : String(err)}`, data: { sessionFile, outcome, error: String(err) } });
  }
}

/**
 * Get all non-abandoned projects for prompt context and validation.
 */
export function getExistingProjects(): { id: string; title: string; stage: string; status: string | null; icon: string | null; entities: string }[] {
  try {
    const db = getTrackerDb();
    const rows = db.all(
      `SELECT id, title, stage, status, icon, entities FROM projects WHERE stage != 'archived' ORDER BY updated_at DESC`,
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        stage: row.stage as string,
        status: (row.status as string) ?? null,
        icon: (row.icon as string) ?? null,
        entities: (row.entities as string) ?? '[]',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Return flat pipe-delimited records of non-archived projects for the tracker prompt.
 */
export function getProjectsForPrompt(): string {
  try {
    const db = getTrackerDb();
    const stmt = db.prepare(
      `SELECT id, type, stage, parent_id, title, status, entities
       FROM projects
       WHERE stage != 'archived'
       ORDER BY updated_at DESC`,
    );
    let rows: Array<{
      id: string;
      type: string;
      stage: string;
      parent_id: string | null;
      title: string;
      status: string | null;
      entities: string | null;
    }>;
    try {
      rows = stmt.all() as typeof rows;
    } finally {
      stmt.finalize();
    };

    if (rows.length === 0) return '';

    const sanitize = (s: string | null): string =>
      (s ?? '').replace(/\|/g, '-').replace(/[\r\n]+/g, ' ');

    return rows
      .map(
        (r) =>
          `id=${r.id} | type=${r.type} | stage=${r.stage} | parent=${r.parent_id ?? '-'} | title=${sanitize(r.title)} | status=${sanitize(r.status)} | entities=${r.entities ?? '[]'}`,
      )
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Return compact `id | stage | title` lines for non-archived projects.
 * Gen 3 format — progressive disclosure via `crispy-tracker show --id`.
 */
export function getCompactProjectsForPrompt(): string {
  try {
    const db = getTrackerDb();
    const rows = db.all(
      `SELECT id, stage, title FROM projects WHERE stage != 'archived' ORDER BY updated_at DESC`,
    ) as Array<{ id: string; stage: string; title: string }>;

    if (rows.length === 0) return '';

    return rows
      .map(r => `${r.id} | ${r.stage} | ${r.title}`)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Get all non-abandoned projects with linked sessions and files for the UI.
 *
 * Returns projects with session file paths and resource files.
 * Session enrichment (title, preview, modifiedAt) happens in the RPC handler
 * where the session list cache is available.
 */
export function getProjectsWithDetails(): Array<{
  id: string;
  title: string;
  stage: string;
  status: string | null;
  icon: string | null;
  sortOrder: number | null;
  blockedBy: string | null;
  summary: string | null;
  branch: string | null;
  entities: string;
  createdAt: string;
  closedAt: string | null;
  lastActivityAt: string | null;
  sessionFiles: string[];
  files: Array<{ path: string; note: string | null }>;
}> {
  try {
    const db = getTrackerDb();

    const projects = db.all(
      `SELECT id, title, stage, status, icon, sort_order, blocked_by, summary, branch, entities, created_at, closed_at, last_activity_at
       FROM projects ORDER BY last_activity_at DESC`,
    );

    const sessionStmt = db.prepare(
      `SELECT session_file FROM project_sessions WHERE project_id = ? ORDER BY linked_at ASC`,
    );
    const fileStmt = db.prepare(
      `SELECT file_path, note FROM project_files WHERE project_id = ?`,
    );

    try {
      return projects.map((r) => {
        const row = r as Record<string, unknown>;
        const id = row.id as string;

        const sessionRows = sessionStmt.all([id]) as Array<Record<string, unknown>>;
        const fileRows = fileStmt.all([id]) as Array<Record<string, unknown>>;

        return {
          id,
          title: row.title as string,
          stage: row.stage as string,
          status: (row.status as string) ?? null,
          icon: (row.icon as string) ?? null,
          sortOrder: (row.sort_order as number) ?? null,
          blockedBy: (row.blocked_by as string) ?? null,
          summary: (row.summary as string) ?? null,
          branch: (row.branch as string) ?? null,
          entities: (row.entities as string) ?? '[]',
          createdAt: row.created_at as string,
          closedAt: (row.closed_at as string) ?? null,
          lastActivityAt: (row.last_activity_at as string) ?? null,
          sessionFiles: sessionRows.map((s) => s.session_file as string),
          files: fileRows.map((f) => ({
            path: f.file_path as string,
            note: (f.note as string) ?? null,
          })),
        };
      });
    } finally {
      sessionStmt.finalize();
      fileStmt.finalize();
    }
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
  stage: string;
  type: string;
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
    const migrateActivity = db.prepare(
      `UPDATE project_activity SET project_id = ? WHERE project_id = ?`,
    );
    const reparentChildren = db.prepare(
      `UPDATE projects SET parent_id = ? WHERE parent_id = ?`,
    );
    const deleteSessions = db.prepare(`DELETE FROM project_sessions WHERE project_id = ?`);
    const deleteFiles = db.prepare(`DELETE FROM project_files WHERE project_id = ?`);
    const deleteActivity = db.prepare(`DELETE FROM project_activity WHERE project_id = ?`);
    const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);

    try {
      updateSurvivor.run([title, summary, JSON.stringify(unionedEntities), earlierCreated, new Date().toISOString(), keepId]);
      reparentChildren.run([keepId, removeId]);
      migrateSessions.run([keepId, removeId]);
      migrateFiles.run([keepId, removeId]);
      migrateActivity.run([keepId, removeId]);
      deleteSessions.run([removeId]);
      deleteFiles.run([removeId]);
      deleteActivity.run([removeId]);  // cleanup any remaining (shouldn't be any after migrate)
      deleteProject.run([removeId]);
    } finally {
      updateSurvivor.finalize();
      reparentChildren.finalize();
      migrateSessions.finalize();
      migrateFiles.finalize();
      migrateActivity.finalize();
      deleteSessions.finalize();
      deleteFiles.finalize();
      deleteActivity.finalize();
      deleteProject.finalize();
    }

    db.exec('COMMIT');

    log({
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
    // Load all non-archived projects with full data for comparison
    const db = getTrackerDb();
    const rows = db.all(
      `SELECT id, title, stage, type, summary, entities, created_at, updated_at
       FROM projects WHERE stage != 'archived' ORDER BY updated_at DESC`,
    );
    const projects: ProjectRow[] = rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        stage: row.stage as string,
        type: (row.type as string) ?? 'project',
        summary: (row.summary as string) ?? null,
        entities: (row.entities as string) ?? '[]',
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      };
    });

    if (projects.length < 2) return;

    const candidates = findDupeCandidates(projects);
    if (candidates.length === 0) return;

    log({ level: 'debug', source: 'rosie.dedup', summary: `Found ${candidates.length} candidate pair(s)` });

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
        log({ level: 'debug', source: 'rosie.dedup', summary: `Auto-merge: "${removeProject.title}" → "${keepProject.title}" (${candidate.reason})` });
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
      log({ level: 'debug', source: 'rosie.dedup', summary: `Sweep complete — merged ${merged.size} duplicate(s)` });
    }
  } catch (err) {
    log({ level: 'warn', source: 'rosie.dedup', summary: `Sweep failed: ${err instanceof Error ? err.message : String(err)}` });
    log({
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
// Semantic Similarity — Lightweight embedding-based duplicate detection
// ============================================================================

/**
 * Get non-archived projects with their text for embedding.
 * Returns id, title, and a text string suitable for embedding (title + summary).
 */
export function getProjectTextsForEmbedding(): Array<{ id: string; title: string; text: string }> {
  try {
    const db = getTrackerDb();
    const rows = db.all(
      `SELECT id, title, summary FROM projects WHERE stage != 'archived' ORDER BY updated_at DESC`,
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const title = row.title as string;
      const summary = (row.summary as string) ?? '';
      return {
        id: row.id as string,
        title,
        text: summary ? `${title} ${summary}` : title,
      };
    });
  } catch {
    return [];
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
    const rosieModel = snap.settings.rosie.bot.model;
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
    log({ level: 'warn', source: 'rosie.dedup', summary: `LLM adjudication failed: ${err instanceof Error ? err.message : String(err)}` });
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
