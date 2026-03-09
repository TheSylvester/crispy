/**
 * Provenance Store — SQLite persistence and queries
 *
 * Pure functions with explicit DB access via getDb() from crispy-db.ts.
 * Pattern matches activity-index.ts — stateless, no singleton state.
 *
 * @module provenance/store
 */

import { getDb } from '../crispy-db.js';
import { dbPath } from '../activity-index.js';
import type {
  RawMutation,
  MatchedCommit,
  CommitFileChange,
  CommitSession,
  FileMutationRecord,
  ProvenanceScanState,
  CommitForEmbedding,
} from './types.js';

// ============================================================================
// Helpers
// ============================================================================

function db() {
  return getDb(dbPath());
}

// ============================================================================
// Write Functions
// ============================================================================

/**
 * Insert file mutations from a transcript scan.
 * Uses INSERT OR IGNORE for dedup on (session_file, tool_use_id).
 */
export function insertMutations(
  sessionFile: string,
  sessionId: string | null,
  mutations: RawMutation[],
): void {
  if (mutations.length === 0) return;

  const d = db();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO file_mutations
      (session_file, session_id, tool, bash_category, file_path, timestamp,
       message_uuid, tool_use_id, byte_offset, command, old_hash, new_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    d.exec('BEGIN');
    for (const m of mutations) {
      stmt.run([
        sessionFile,
        sessionId,
        m.tool,
        m.bashCategory ?? null,
        m.filePath,
        m.timestamp,
        m.messageUuid,
        m.toolUseId,
        m.byteOffset,
        m.command ?? null,
        m.oldHash ?? null,
        m.newHash ?? null,
      ]);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    stmt.finalize();
  }
}

/** Insert a matched commit */
export function insertCommit(commit: MatchedCommit): void {
  db().run(`
    INSERT OR REPLACE INTO commit_index
      (sha, message, author, author_date, repo_path, session_file,
       session_id, message_uuid, match_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    commit.sha,
    commit.message,
    commit.author,
    commit.authorDate,
    commit.repoPath,
    commit.sessionFile,
    commit.sessionId,
    commit.messageUuid,
    commit.matchConfidence,
  ]);
}

/** Insert file changes for a commit */
export function insertCommitFileChanges(sha: string, changes: CommitFileChange[]): void {
  if (changes.length === 0) return;

  const d = db();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO commit_file_changes (commit_sha, file_path, additions, deletions)
    VALUES (?, ?, ?, ?)
  `);

  try {
    d.exec('BEGIN');
    for (const c of changes) {
      stmt.run([sha, c.filePath, c.additions, c.deletions]);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    stmt.finalize();
  }
}

/**
 * Link mutations to a commit by updating commit_sha for mutations
 * in a time window preceding the commit.
 */
export function linkMutationsToCommit(
  sessionFile: string,
  commitSha: string,
  commitTimestamp: string,
  windowStart: string,
): void {
  db().run(`
    UPDATE file_mutations
    SET commit_sha = ?
    WHERE session_file = ?
      AND commit_sha IS NULL
      AND timestamp IS NOT NULL
      AND timestamp >= ?
      AND timestamp <= ?
      AND tool IN ('Edit', 'Write')
  `, [commitSha, sessionFile, windowStart, commitTimestamp]);
}

// ============================================================================
// Scan State
// ============================================================================

/** Load all provenance scan states */
export function loadProvenanceScanStates(): Map<string, ProvenanceScanState> {
  const rows = db().all('SELECT file_path, mtime, size, byte_offset FROM provenance_scan_state') as Array<Record<string, unknown>>;
  const map = new Map<string, ProvenanceScanState>();
  for (const row of rows) {
    map.set(row.file_path as string, {
      filePath: row.file_path as string,
      mtime: row.mtime as number,
      size: row.size as number,
      byteOffset: row.byte_offset as number,
    });
  }
  return map;
}

/** Save provenance scan state for a file */
export function saveProvenanceScanState(state: ProvenanceScanState): void {
  db().run(
    'INSERT OR REPLACE INTO provenance_scan_state (file_path, mtime, size, byte_offset) VALUES (?, ?, ?, ?)',
    [state.filePath, state.mtime, state.size, state.byteOffset],
  );
}

/** Save repo HEAD tracking state */
export function saveRepoState(repoPath: string, headSha: string): void {
  db().run(
    'INSERT OR REPLACE INTO provenance_repo_state (repo_path, head_sha) VALUES (?, ?)',
    [repoPath, headSha],
  );
}

// ============================================================================
// Query Functions
// ============================================================================

/** Get session attribution for a commit */
export function getCommitSession(sha: string): CommitSession | null {
  const row = db().get(`
    SELECT sha, message, author_date, session_file, session_id, match_confidence
    FROM commit_index WHERE sha = ?
  `, [sha]) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    sha: row.sha as string,
    message: row.message as string,
    authorDate: row.author_date as string,
    sessionFile: row.session_file as string | null,
    sessionId: row.session_id as string | null,
    matchConfidence: row.match_confidence as number,
  };
}

/** Get all commits from a session */
export function getSessionCommits(sessionFile: string): CommitSession[] {
  const rows = db().all(`
    SELECT sha, message, author_date, session_file, session_id, match_confidence
    FROM commit_index WHERE session_file = ?
    ORDER BY author_date ASC
  `, [sessionFile]) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    sha: row.sha as string,
    message: row.message as string,
    authorDate: row.author_date as string,
    sessionFile: row.session_file as string | null,
    sessionId: row.session_id as string | null,
    matchConfidence: row.match_confidence as number,
  }));
}

/** Get all sessions that touched a file */
export function getFileMutations(filePath: string): FileMutationRecord[] {
  const rows = db().all(`
    SELECT session_file, session_id, tool, bash_category, file_path,
           timestamp, commit_sha, command
    FROM file_mutations WHERE file_path = ?
    ORDER BY timestamp ASC
  `, [filePath]) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    sessionFile: row.session_file as string,
    sessionId: row.session_id as string | null,
    tool: row.tool as string,
    bashCategory: row.bash_category as string | null,
    filePath: row.file_path as string | null,
    timestamp: row.timestamp as string | null,
    commitSha: row.commit_sha as string | null,
    command: row.command as string | null,
  }));
}

/** Get uncommitted mutations for a file */
export function getUncommittedMutations(filePath: string): FileMutationRecord[] {
  const rows = db().all(`
    SELECT session_file, session_id, tool, bash_category, file_path,
           timestamp, commit_sha, command
    FROM file_mutations WHERE file_path = ? AND commit_sha IS NULL
    ORDER BY timestamp ASC
  `, [filePath]) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    sessionFile: row.session_file as string,
    sessionId: row.session_id as string | null,
    tool: row.tool as string,
    bashCategory: row.bash_category as string | null,
    filePath: row.file_path as string | null,
    timestamp: row.timestamp as string | null,
    commitSha: null,
    command: row.command as string | null,
  }));
}

/** FTS5 search on commit messages */
export function searchCommits(query: string): CommitSession[] {
  const rows = db().all(`
    SELECT c.sha, c.message, c.author_date, c.session_file, c.session_id, c.match_confidence
    FROM commit_fts f
    JOIN commit_index c ON f.rowid = c.rowid
    WHERE commit_fts MATCH ?
    ORDER BY rank
    LIMIT 50
  `, [query]) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    sha: row.sha as string,
    message: row.message as string,
    authorDate: row.author_date as string,
    sessionFile: row.session_file as string | null,
    sessionId: row.session_id as string | null,
    matchConfidence: row.match_confidence as number,
  }));
}

/** Get commits prepared for external embedding */
export function getCommitsForEmbedding(since?: string): CommitForEmbedding[] {
  const d = db();
  const rows = d.all(
    since
      ? 'SELECT sha, message, author_date, repo_path, session_file, session_id FROM commit_index WHERE author_date > ? ORDER BY author_date ASC'
      : 'SELECT sha, message, author_date, repo_path, session_file, session_id FROM commit_index ORDER BY author_date ASC',
    since ? [since] : [],
  ) as Array<Record<string, unknown>>;

  if (rows.length === 0) return [];

  // Batch-fetch all file changes in one query to avoid N+1
  const shas = rows.map(r => r.sha as string);
  const placeholders = shas.map(() => '?').join(',');
  const allFileRows = d.all(
    `SELECT commit_sha, file_path, additions, deletions FROM commit_file_changes WHERE commit_sha IN (${placeholders})`,
    shas,
  ) as Array<Record<string, unknown>>;

  // Group file changes by commit SHA
  const filesBySha = new Map<string, CommitFileChange[]>();
  for (const f of allFileRows) {
    const sha = f.commit_sha as string;
    if (!filesBySha.has(sha)) filesBySha.set(sha, []);
    filesBySha.get(sha)!.push({
      filePath: f.file_path as string,
      additions: f.additions as number,
      deletions: f.deletions as number,
    });
  }

  return rows.map(row => {
    const sha = row.sha as string;
    return {
      sha,
      message: row.message as string,
      authorDate: row.author_date as string,
      repoPath: row.repo_path as string,
      sessionFile: row.session_file as string | null,
      sessionId: row.session_id as string | null,
      files: filesBySha.get(sha) ?? [],
    };
  });
}

/** Get recent file mutations */
export function getRecentMutations(limit = 100): FileMutationRecord[] {
  const rows = db().all(`
    SELECT session_file, session_id, tool, bash_category, file_path,
           timestamp, commit_sha, command
    FROM file_mutations
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit]) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    sessionFile: row.session_file as string,
    sessionId: row.session_id as string | null,
    tool: row.tool as string,
    bashCategory: row.bash_category as string | null,
    filePath: row.file_path as string | null,
    timestamp: row.timestamp as string | null,
    commitSha: row.commit_sha as string | null,
    command: row.command as string | null,
  }));
}
