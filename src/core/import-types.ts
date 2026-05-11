/**
 * Import Types — shared cross-layer types for OS-drop file import
 *
 * Used by `core/import-service.ts` (canonical owner) and surfaced through
 * `host/client-connection.ts` RPC and the webview transport. No runtime
 * code lives here — types only, so both daemon and webview bundles can
 * depend on this module without dragging in `node:fs`.
 *
 * Boundaries: this is the canonical wire shape for the import flow. Any
 * additions must keep the structure plain-JSON-serializable (the values
 * cross the JSON-RPC boundary verbatim).
 *
 * @module core/import-types
 */

/** Conflict resolution chosen by the user for one or all conflicts. */
export type Resolution = 'replace' | 'skip' | 'rename';

/** A pre-existing destination file/dir that would be overwritten. */
export interface ConflictItem {
  /** Stable id for `Resolutions` keying. */
  id: string;
  /** Source absolute path. */
  srcPath: string;
  /** Destination absolute path that already exists. */
  destPath: string;
  /** Destination path relative to the trust root, for display. */
  destRelPath: string;
  /** True for directory-vs-directory conflicts (rename creates a new dir name). */
  isDirectory: boolean;
  /** Source size in bytes (0 for directories). */
  srcSize: number;
  /** Source mtime as epoch ms. */
  srcMtimeMs: number;
  /** Destination size in bytes (0 for directories). */
  destSize: number;
  /** Destination mtime as epoch ms. */
  destMtimeMs: number;
}

/** Non-conflict error surfaced during preview (cycle, missing src, escape). */
export interface ImportError {
  /** Source path involved (or destination, for containment errors). */
  path: string;
  /** Human-readable cause. */
  message: string;
  /** Discriminator. */
  code: 'cycle' | 'missing-source' | 'unreadable-source' | 'dest-escape' | 'unknown';
}

/** Per-leaf failure during execute. */
export interface ImportExecError {
  srcPath: string;
  destPath: string;
  message: string;
}

/** Aggregate counts + warning surfaced after preview walk. */
export interface ImportSummary {
  /** Total file leaves to copy (excludes dirs). */
  fileCount: number;
  /** Directory entries (including empty ones) to materialize. */
  dirCount: number;
  /** Symlinks to copy verbatim. */
  symlinkCount: number;
  /** Sum of source file sizes in bytes. */
  totalBytes: number;
  /** Soft-cap warning when entries exceed the soft cap. */
  warning?: 'large-import';
}

/** Plan returned from `previewImport`. */
export interface ImportPlan {
  /** Server-generated plan id; required to call execute/cancel. */
  planId: string;
  /** Aggregate counts. */
  summary: ImportSummary;
  /** Conflicts requiring user resolution. */
  conflicts: ConflictItem[];
  /** Non-conflict errors discovered during preview. */
  errors: ImportError[];
}

/** Resolution map from the conflict modal: { conflictId: action }. */
export type Resolutions = Record<string, Resolution>;

/** Final report returned from `executeImport`. */
export interface ImportReport {
  copiedCount: number;
  skippedCount: number;
  failedCount: number;
  cancelled: boolean;
  errors: ImportExecError[];
}

/** Streaming progress event for the toast. */
export interface ImportProgressEvent {
  type: 'import-progress';
  planId: string;
  /** Number of leaves processed so far. */
  current: number;
  /** Total leaves to process (matches `summary.fileCount`). */
  total: number;
  /** Most recently processed source path, for display. */
  currentPath: string;
  /** True on the terminal frame (success or cancel). */
  done: boolean;
}
