/**
 * Import Service — copy external files/folders into a project.
 *
 * Owns: import plan lifecycle (preview → execute → cancel). Created for the
 * Tauri OS-drop flow; the VS Code shell follow-up will reuse the same RPCs.
 *
 * Boundaries: trust-root resolution lives in `host/client-connection.ts`
 * (which validates `projectCwdHint` against subscribed sessions or
 * `extraAllowedRoots`). This service receives an already-validated
 * destination root and performs containment + cycle checks as defense in
 * depth — it does not accept arbitrary destination paths from the webview
 * directly. Does not touch `~/.crispy/`.
 *
 * @module core/import-service
 */

import { promises as fsp } from 'node:fs';
import { resolve, join, dirname, basename, extname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from './log.js';
import { normalizePath } from './url-path-resolver.js';
import type {
  ConflictItem,
  ImportError,
  ImportExecError,
  ImportPlan,
  ImportProgressEvent,
  ImportReport,
  Resolution,
  Resolutions,
  ImportSummary,
} from './import-types.js';

// ============================================================================
// Internal plan storage
// ============================================================================

interface WalkLeaf {
  srcAbs: string;
  destAbs: string;
  size: number;
  mtimeMs: number;
}

interface WalkDir {
  srcAbs: string;
  destAbs: string;
}

interface WalkSymlink {
  srcAbs: string;
  destAbs: string;
}

interface StoredPlan {
  planId: string;
  trustRoot: string;
  destAbs: string;
  dirs: WalkDir[];
  leaves: WalkLeaf[];
  symlinks: WalkSymlink[];
  conflicts: ConflictItem[];
  errors: ImportError[];
  createdAt: number;
  cancelled: boolean;
  finishedAt?: number;
}

const PLAN_TTL_MS = 15 * 60 * 1000;       // 15 min before execute
const POST_FINISH_TTL_MS = 60 * 1000;     // 60s grace after execute terminal frame
const SOFT_CAP_ENTRIES = 10_000;

const plans = new Map<string, StoredPlan>();

function gcExpired(): void {
  const now = Date.now();
  for (const [id, plan] of plans) {
    if (plan.finishedAt !== undefined) {
      if (now - plan.finishedAt > POST_FINISH_TTL_MS) plans.delete(id);
    } else if (now - plan.createdAt > PLAN_TTL_MS) {
      plans.delete(id);
    }
  }
}

// ============================================================================
// Containment helpers
// ============================================================================

function isContained(child: string, parent: string): boolean {
  const cn = normalizePath(child);
  const pn = normalizePath(parent);
  if (cn === pn) return true;
  const prefix = pn.endsWith('/') ? pn : pn + '/';
  return cn.startsWith(prefix);
}

/** Canonicalize a path; on ENOENT returns the resolved (non-canonical) path. */
async function canonOrResolve(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return resolve(p);
  }
}

// ============================================================================
// Walk
// ============================================================================

/**
 * Walk a single source path and collect leaves/dirs/symlinks.
 *
 * - Files: one leaf at `destBase`.
 * - Directories: one dir entry for the dir itself, then recursive walk;
 *   empty dirs still produce a dir entry so `mkdir` materializes them.
 * - Symlinks: one symlink entry, never followed.
 */
async function walkSource(
  srcAbs: string,
  destBase: string,
  out: { leaves: WalkLeaf[]; dirs: WalkDir[]; symlinks: WalkSymlink[]; errors: ImportError[] },
): Promise<void> {
  let lst;
  try {
    lst = await fsp.lstat(srcAbs);
  } catch (err) {
    out.errors.push({
      path: srcAbs,
      message: err instanceof Error ? err.message : String(err),
      code: 'unreadable-source',
    });
    return;
  }

  if (lst.isSymbolicLink()) {
    out.symlinks.push({ srcAbs, destAbs: destBase });
    return;
  }

  if (lst.isFile()) {
    out.leaves.push({
      srcAbs,
      destAbs: destBase,
      size: lst.size,
      mtimeMs: lst.mtimeMs,
    });
    return;
  }

  if (!lst.isDirectory()) {
    out.errors.push({
      path: srcAbs,
      message: 'Source is not a regular file, directory, or symlink',
      code: 'unreadable-source',
    });
    return;
  }

  // Emit the dir entry before recursing so empty dirs still materialize.
  out.dirs.push({ srcAbs, destAbs: destBase });

  let entries;
  try {
    entries = await fsp.readdir(srcAbs, { withFileTypes: true });
  } catch (err) {
    out.errors.push({
      path: srcAbs,
      message: err instanceof Error ? err.message : String(err),
      code: 'unreadable-source',
    });
    return;
  }

  for (const ent of entries) {
    const childSrc = join(srcAbs, ent.name);
    const childDest = join(destBase, ent.name);
    await walkSource(childSrc, childDest, out);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build an import plan from source paths and a destination relative dir.
 *
 * Caller (`client-connection.ts`) is responsible for resolving `trustRoot`
 * from a subscribed session's projectPath or `extraAllowedRoots`. This
 * function does not trust webview-supplied absolute paths beyond `trustRoot`.
 */
export async function previewImport(args: {
  trustRoot: string;
  destRelDir: string;
  srcs: string[];
}): Promise<ImportPlan> {
  gcExpired();

  const trustRoot = await canonOrResolve(args.trustRoot);
  const destAbs = await canonOrResolve(resolve(trustRoot, args.destRelDir));

  const errors: ImportError[] = [];

  // Containment: dest must equal or live within the trust root.
  if (!isContained(destAbs, trustRoot)) {
    errors.push({
      path: destAbs,
      message: `Destination "${destAbs}" is outside the project root.`,
      code: 'dest-escape',
    });
    // Don't proceed with walks — return early with an empty plan.
    const planId = randomUUID();
    const empty: ImportPlan = {
      planId,
      summary: { fileCount: 0, dirCount: 0, symlinkCount: 0, totalBytes: 0 },
      conflicts: [],
      errors,
    };
    plans.set(planId, {
      planId,
      trustRoot,
      destAbs,
      dirs: [],
      leaves: [],
      symlinks: [],
      conflicts: [],
      errors,
      createdAt: Date.now(),
      cancelled: false,
    });
    return empty;
  }

  const dirs: WalkDir[] = [];
  const leaves: WalkLeaf[] = [];
  const symlinks: WalkSymlink[] = [];

  for (const rawSrc of args.srcs) {
    const srcAbs = resolve(rawSrc);
    let srcStat;
    try {
      srcStat = await fsp.lstat(srcAbs);
    } catch (err) {
      errors.push({
        path: srcAbs,
        message: err instanceof Error ? err.message : String(err),
        code: 'missing-source',
      });
      continue;
    }

    // Use the source's own name for the destination — for symlinks this
    // preserves the link name rather than the resolved target's name.
    const destBase = join(destAbs, basename(srcAbs));

    // Cycle check applies only to real directories. For symlinks we copy
    // verbatim and never recurse, so cycles are physically impossible.
    if (srcStat.isDirectory() && !srcStat.isSymbolicLink()) {
      let srcCanonical: string;
      try {
        srcCanonical = await fsp.realpath(srcAbs);
      } catch {
        srcCanonical = srcAbs;
      }
      if (isContained(destAbs, srcCanonical)) {
        errors.push({
          path: srcAbs,
          message: `Cannot copy "${srcAbs}" into itself or a descendant.`,
          code: 'cycle',
        });
        continue;
      }
    }

    await walkSource(srcAbs, destBase, { leaves, dirs, symlinks, errors });
  }

  // Conflict detection — stat each leaf's destination only.
  // Pre-existing directories at the destination are silently merged via
  // mkdir-recursive (matches Explorer/Finder: "merge folder?" only ever
  // surfaces per-file conflicts inside, never the folder itself).
  // Symlinks are always replaced verbatim if present (no prompt — matches Finder).
  const conflicts: ConflictItem[] = [];

  // Bounded-concurrency stat: serial would block the conflict modal for
  // seconds on cold-cache 1000-file drops. 16 inflight is a reasonable
  // tradeoff between latency and FD pressure.
  const STAT_CONCURRENCY = 16;
  for (let i = 0; i < leaves.length; i += STAT_CONCURRENCY) {
    const batch = leaves.slice(i, i + STAT_CONCURRENCY);
    const stats = await Promise.all(batch.map(l => fsp.lstat(l.destAbs).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      const dstStat = stats[j];
      const leaf = batch[j]!;
      if (!dstStat) continue;
      conflicts.push({
        id: randomUUID(),
        srcPath: leaf.srcAbs,
        destPath: leaf.destAbs,
        destRelPath: relative(trustRoot, leaf.destAbs),
        isDirectory: false,
        srcSize: leaf.size,
        srcMtimeMs: leaf.mtimeMs,
        destSize: dstStat.isDirectory() ? 0 : dstStat.size,
        destMtimeMs: dstStat.mtimeMs,
      });
    }
  }

  const totalBytes = leaves.reduce((acc, l) => acc + l.size, 0);
  const totalEntries = leaves.length + dirs.length + symlinks.length;
  const summary: ImportSummary = {
    fileCount: leaves.length,
    dirCount: dirs.length,
    symlinkCount: symlinks.length,
    totalBytes,
  };
  if (totalEntries > SOFT_CAP_ENTRIES) summary.warning = 'large-import';

  const planId = randomUUID();
  const plan: StoredPlan = {
    planId,
    trustRoot,
    destAbs,
    dirs,
    leaves,
    symlinks,
    conflicts,
    errors,
    createdAt: Date.now(),
    cancelled: false,
  };
  plans.set(planId, plan);

  log({
    source: 'import-service',
    level: 'info',
    summary: `previewImport plan=${planId} files=${leaves.length} dirs=${dirs.length} symlinks=${symlinks.length} conflicts=${conflicts.length} errors=${errors.length}`,
  });

  return { planId, summary, conflicts, errors };
}

/** Resolve a free destination for an auto-renamed leaf. */
async function findRenameTarget(destPath: string): Promise<string | null> {
  const dir = dirname(destPath);
  const base = basename(destPath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`);
    try {
      await fsp.lstat(candidate);
      // exists, try next
    } catch {
      return candidate;
    }
  }
  return null;
}

/**
 * Execute a previously-built plan.
 *
 * Phase A: mkdir all dirs (parents-before-children).
 * Phase B: copy leaves + symlinks one at a time so we can emit progress,
 *          handle per-leaf conflict resolution, and check the cancel flag.
 */
export async function executeImport(args: {
  planId: string;
  resolutions: Resolutions;
  /** Receives intermediate + terminal frames. Throttling lives at the host. */
  onProgress: (e: ImportProgressEvent) => void;
}): Promise<ImportReport> {
  const stored = plans.get(args.planId);
  if (!stored) throw new Error(`Unknown plan id: ${args.planId}`);
  const plan: StoredPlan = stored;

  // Defense in depth — re-validate containment.
  if (!isContained(plan.destAbs, plan.trustRoot)) {
    throw new Error('Plan destination escapes trust root');
  }

  // Build a quick lookup: destPath → resolution from the conflict list.
  const conflictByDest = new Map<string, ConflictItem>();
  for (const c of plan.conflicts) conflictByDest.set(c.destPath, c);

  function resolutionFor(destPath: string): Resolution {
    const c = conflictByDest.get(destPath);
    if (!c) return 'replace'; // no pre-existing entry — copy as new
    return args.resolutions[c.id] ?? 'replace';
  }

  const totalLeaves = plan.leaves.length + plan.symlinks.length;
  let copiedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: ImportExecError[] = [];

  // ---- Phase A: ensure destination dirs ----
  // Directory conflicts are not surfaced (see previewImport): pre-existing
  // dirs are merged via mkdir-recursive, matching Explorer/Finder.
  // Collapse to leaf-only paths — `mkdir({recursive: true})` builds parents,
  // so we'd otherwise pay an EEXIST syscall for every ancestor in deep trees.
  const allDirs = new Set<string>();
  allDirs.add(plan.destAbs);
  for (const d of plan.dirs) allDirs.add(d.destAbs);
  for (const leaf of plan.leaves) allDirs.add(dirname(leaf.destAbs));
  for (const s of plan.symlinks) allDirs.add(dirname(s.destAbs));

  const sorted = Array.from(allDirs).sort();
  const leafDirs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1];
    // Drop any path that is a strict prefix of the next entry — recursive
    // mkdir on the descendant already creates it.
    if (next && (next === sorted[i] + '/' || next.startsWith(sorted[i] + '/'))) continue;
    leafDirs.push(sorted[i]!);
  }
  const mkdirResults = await Promise.all(
    leafDirs.map(d => fsp.mkdir(d, { recursive: true }).then(
      () => null,
      err => ({ destPath: d, message: err instanceof Error ? err.message : String(err) }),
    )),
  );
  for (const r of mkdirResults) {
    if (r) errors.push({ srcPath: '', destPath: r.destPath, message: r.message });
  }

  let processedLeaves = 0;
  function emit(currentPath: string, done: boolean): void {
    args.onProgress({
      type: 'import-progress',
      planId: plan.planId,
      current: processedLeaves,
      total: totalLeaves,
      currentPath,
      done,
    });
  }

  // ---- Phase B: copy leaves ----
  for (const leaf of plan.leaves) {
    if (plan.cancelled) break;
    let dest = leaf.destAbs;
    const action = resolutionFor(dest);

    if (action === 'skip') {
      skippedCount++;
      processedLeaves++;
      emit(leaf.srcAbs, false);
      continue;
    }

    if (action === 'rename') {
      const renamed = await findRenameTarget(dest);
      if (!renamed) {
        failedCount++;
        errors.push({ srcPath: leaf.srcAbs, destPath: dest, message: 'Rename limit exceeded (>=1000 collisions)' });
        processedLeaves++;
        emit(leaf.srcAbs, false);
        continue;
      }
      dest = renamed;
    }

    try {
      // - replace: overwrite existing destination (force=true).
      // - rename: dest just probed as free; force=false avoids any
      //   accidental overwrite if a TOCTOU race lands a new file there.
      await fsp.cp(leaf.srcAbs, dest, {
        recursive: false,
        force: action === 'replace',
        errorOnExist: false,
        verbatimSymlinks: true,
      });
      copiedCount++;
    } catch (err) {
      failedCount++;
      errors.push({
        srcPath: leaf.srcAbs,
        destPath: dest,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    processedLeaves++;
    emit(leaf.srcAbs, false);
  }

  // ---- Phase B (cont.): copy symlinks verbatim ----
  for (const s of plan.symlinks) {
    if (plan.cancelled) break;
    let dest = s.destAbs;
    const action = resolutionFor(dest);

    if (action === 'skip') {
      skippedCount++;
      processedLeaves++;
      emit(s.srcAbs, false);
      continue;
    }
    if (action === 'rename') {
      const renamed = await findRenameTarget(dest);
      if (!renamed) {
        failedCount++;
        errors.push({ srcPath: s.srcAbs, destPath: dest, message: 'Rename limit exceeded (>=1000 collisions)' });
        processedLeaves++;
        emit(s.srcAbs, false);
        continue;
      }
      dest = renamed;
    }
    try {
      // For replace: ensure target doesn't exist (symlink doesn't honor `force`).
      if (action === 'replace') {
        try { await fsp.unlink(dest); } catch { /* may not exist */ }
      }
      const linkTarget = await fsp.readlink(s.srcAbs);
      await fsp.symlink(linkTarget, dest);
      copiedCount++;
    } catch (err) {
      failedCount++;
      errors.push({
        srcPath: s.srcAbs,
        destPath: dest,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    processedLeaves++;
    emit(s.srcAbs, false);
  }

  plan.finishedAt = Date.now();
  emit('', true);

  const report: ImportReport = {
    copiedCount,
    skippedCount,
    failedCount,
    cancelled: plan.cancelled,
    errors,
  };

  log({
    source: 'import-service',
    level: 'info',
    summary: `executeImport plan=${plan.planId} copied=${copiedCount} skipped=${skippedCount} failed=${failedCount} cancelled=${plan.cancelled}`,
  });

  return report;
}

/**
 * Mark a plan as cancelled. The execute loop checks the flag before each
 * leaf. Already-copied files stay in place (matches Explorer behavior).
 */
export function cancelImport(planId: string): void {
  const plan = plans.get(planId);
  if (!plan) return;
  plan.cancelled = true;
}

// ============================================================================
// Test seams
// ============================================================================

/** @internal — test-only: drop all stored plans. */
export function _resetForTests(): void {
  plans.clear();
}

/** @internal — test-only: peek at a plan's cancel flag. */
export function _peekCancelledForTests(planId: string): boolean | undefined {
  return plans.get(planId)?.cancelled;
}

// Re-exports so callers can `import { ImportPlan } from 'core/import-service'`
// without crossing into the types module separately.
export type {
  ConflictItem,
  ImportError,
  ImportExecError,
  ImportPlan,
  ImportProgressEvent,
  ImportReport,
  Resolution,
  Resolutions,
  ImportSummary,
} from './import-types.js';
