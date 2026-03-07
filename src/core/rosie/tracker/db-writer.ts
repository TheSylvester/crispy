/**
 * Rosie Tracker DB Writer — UPSERT logic for projects, sessions, and files
 *
 * Writes validated TrackerBlocks to the projects/project_sessions/project_files
 * tables. All writes in a single transaction. New projects get a random UUID;
 * existing projects are updated in place.
 *
 * Also provides getExistingProjects() for building prompt context and the
 * validator's ID set.
 *
 * @module rosie/tracker/db-writer
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../crispy-db.js';
import { ensureCrispyDir, dbPath } from '../../activity-index.js';
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
      `INSERT INTO projects (id, title, status, blocked_by, summary, category, branch, entities, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateProject = db.prepare(
      `UPDATE projects SET
         title = ?, status = ?, blocked_by = ?, summary = ?, category = ?,
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
            p.category || null, p.branch || null, p.entities || '[]',
            now, now, now,
          ]);
        } else {
          // Update existing project
          projectId = p.id;
          updateProject.run([
            p.title, p.status, p.blocked_by || null, p.summary || null, p.category || null,
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
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
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
