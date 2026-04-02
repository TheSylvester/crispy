/**
 * Workspace Roots — registry of allowed workspace directories
 *
 * CRUD operations for explicit workspace roots (user-registered) and
 * allowlist checking that combines explicit roots with implicit paths
 * from session history.
 *
 * All paths are normalized before storage and comparison.
 *
 * @module workspace-roots
 */

import { log } from './log.js';
import { getDb } from './crispy-db.js';
import { dbPath } from './paths.js';
import { normalizePath } from './url-path-resolver.js';
import type { SessionInfo } from './agent-adapter.js';

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceInfo {
  /** Absolute filesystem path */
  path: string;
  /** true = manually added root, false = implicit from session history */
  isExplicit: boolean;
  /** Epoch ms of the most recent session activity under this workspace */
  lastActivityAt?: number;
  /** Remote environment label (e.g. "WSL · Ubuntu") — present if from a remote daemon */
  environment?: string;
}

export interface WorkspaceListResponse {
  /** Server's os.homedir() — needed by fsPathToUrlPath() in the browser */
  home: string;
  /** Server's process.platform — used to deduplicate cross-platform workspaces */
  platform?: string;
  workspaces: WorkspaceInfo[];
}

// ============================================================================
// CRUD
// ============================================================================

/** Add an explicit workspace root. Path is normalized before storage. */
export function addRoot(path: string): void {
  const normalized = normalizePath(path);
  const db = getDb(dbPath());
  db.run(
    'INSERT OR IGNORE INTO workspace_roots (path) VALUES (?)',
    [normalized],
  );
  log({ source: 'workspace', level: 'info', summary: `Workspace root added: ${normalized}` });
}

/** Remove an explicit workspace root. */
export function removeRoot(path: string): void {
  const normalized = normalizePath(path);
  const db = getDb(dbPath());
  db.run('DELETE FROM workspace_roots WHERE path = ?', [normalized]);
  log({ source: 'workspace', level: 'info', summary: `Workspace root removed: ${normalized}` });
}

/** List all explicit workspace roots. */
export function listRoots(): string[] {
  const db = getDb(dbPath());
  const rows = db.all('SELECT path FROM workspace_roots ORDER BY added_at') as Array<{ path: string }>;
  return rows.map(r => normalizePath(r.path));
}

// ============================================================================
// Allowlist Checking
// ============================================================================

/**
 * Check if a path is within an allowed directory.
 * Both paths should be normalized before calling.
 */
function isWithinNormalized(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(prefix);
}

/**
 * Check if a filesystem path is allowed — either an explicit root (or child),
 * or a path where sessions have previously existed.
 */
export function isPathAllowed(fsPath: string, sessions: SessionInfo[]): boolean {
  const normalized = normalizePath(fsPath);

  // Check explicit roots
  const roots = listRoots();
  for (const root of roots) {
    if (isWithinNormalized(normalized, root)) return true;
  }

  // Check implicit paths from session history
  for (const session of sessions) {
    if (!session.projectPath) continue;
    const sessionPath = normalizePath(session.projectPath);
    if (isWithinNormalized(normalized, sessionPath)) return true;
  }

  return false;
}

/**
 * List all known workspaces: explicit roots + unique paths from session history.
 * Deduplicates by normalized path. Sorted by most recent session activity.
 */
export function listAllWorkspaces(sessions: SessionInfo[]): WorkspaceInfo[] {
  const seen = new Map<string, WorkspaceInfo>();

  // Explicit roots first
  for (const root of listRoots()) {
    seen.set(root, { path: root, isExplicit: true });
  }

  // Session-derived paths + activity timestamps
  for (const session of sessions) {
    if (!session.projectPath) continue;
    const normalized = normalizePath(session.projectPath);
    const ts = session.modifiedAt instanceof Date
      ? session.modifiedAt.getTime()
      : new Date(session.modifiedAt).getTime();

    const existing = seen.get(normalized);
    if (existing) {
      // Update lastActivityAt if this session is more recent
      if (!existing.lastActivityAt || ts > existing.lastActivityAt) {
        existing.lastActivityAt = ts;
      }
      // Tag with remote environment if applicable
      if (session.remoteEnvironment && !existing.environment) {
        existing.environment = session.remoteEnvironment;
      }
    } else {
      seen.set(normalized, {
        path: normalized,
        isExplicit: false,
        lastActivityAt: ts,
        environment: session.remoteEnvironment,
      });
    }
  }

  // Sort by last activity (most recent first), workspaces without activity at the end
  return Array.from(seen.values()).sort((a, b) => {
    const aTime = a.lastActivityAt ?? 0;
    const bTime = b.lastActivityAt ?? 0;
    return bTime - aTime;
  });
}
