/**
 * Tests for Import Service
 *
 * Covers preview/execute/cancel for the OS-drop import flow:
 * - containment + cycle checks
 * - conflict detection
 * - replace / skip / rename actions
 * - empty-dir materialization
 * - symlinks copied verbatim (Unix only)
 * - cancel mid-copy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import {
  previewImport,
  executeImport,
  cancelImport,
  _resetForTests,
  _peekCancelledForTests,
} from '../src/core/import-service.js';
import type { ImportProgressEvent } from '../src/core/import-types.js';

let trustRoot: string;
let workDir: string;

const isWindows = process.platform === 'win32';

beforeEach(() => {
  workDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-import-test-'));
  trustRoot = join(workDir, 'project');
  fs.mkdirSync(trustRoot, { recursive: true });
  _resetForTests();
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const noProgress = (_e: ImportProgressEvent): void => {};

// ============================================================================
// Containment / cycle
// ============================================================================

describe('previewImport — containment', () => {
  it('rejects a destination outside the trust root', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'hi');
    const plan = await previewImport({
      trustRoot,
      destRelDir: '../escape',
      srcs: [src],
    });
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.errors[0]?.code).toBe('dest-escape');
  });

  it('rejects a source that is an ancestor of the destination (cycle)', async () => {
    const ancestor = join(workDir, 'outer');
    fs.mkdirSync(ancestor, { recursive: true });
    fs.writeFileSync(join(ancestor, 'note.txt'), 'x');
    // Move trustRoot inside the ancestor so dest lives under src.
    const insideRoot = join(ancestor, 'inside');
    fs.mkdirSync(insideRoot);
    const plan = await previewImport({
      trustRoot: insideRoot,
      destRelDir: '',
      srcs: [ancestor],
    });
    const cycle = plan.errors.find(e => e.code === 'cycle');
    expect(cycle).toBeDefined();
  });

  it('reports missing source paths', async () => {
    const plan = await previewImport({
      trustRoot,
      destRelDir: '',
      srcs: [join(workDir, 'does-not-exist.txt')],
    });
    expect(plan.errors.some(e => e.code === 'missing-source')).toBe(true);
  });

  // Tauri Windows shell + WSL daemon: Windows Explorer drops arrive as
  // `C:\...` paths; WSL must translate to `/mnt/c/...` before lstat.
  it.skipIf(process.platform !== 'linux')(
    'translates Windows drive-letter paths to /mnt/<drive>/ on Linux',
    async () => {
      const plan = await previewImport({
        trustRoot,
        destRelDir: '',
        srcs: ['C:\\definitely\\does\\not\\exist.txt'],
      });
      const err = plan.errors.find(e => e.code === 'missing-source');
      expect(err).toBeDefined();
      // The reported path should be the translated form, proving the
      // translator ran before lstat.
      expect(err!.path).toBe('/mnt/c/definitely/does/not/exist.txt');
    },
  );
});

// ============================================================================
// Walk + summary
// ============================================================================

describe('previewImport — walk', () => {
  it('counts files, dirs, total bytes', async () => {
    const src = join(workDir, 'pkg');
    fs.mkdirSync(src);
    fs.writeFileSync(join(src, 'a.txt'), 'hello');     // 5 bytes
    fs.writeFileSync(join(src, 'b.txt'), 'world!!');   // 7 bytes
    const sub = join(src, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(join(sub, 'c.txt'), 'xyz');       // 3 bytes
    const empty = join(src, 'empty-dir');
    fs.mkdirSync(empty);

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    expect(plan.summary.fileCount).toBe(3);
    expect(plan.summary.dirCount).toBeGreaterThanOrEqual(3); // pkg, sub, empty-dir
    expect(plan.summary.totalBytes).toBe(15);
    expect(plan.errors).toEqual([]);
  });
});

// ============================================================================
// Conflict detection
// ============================================================================

describe('previewImport — conflict detection', () => {
  it('surfaces pre-existing destination files in conflicts', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(join(trustRoot, 'a.txt'), 'old');

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    expect(plan.conflicts.length).toBe(1);
    expect(plan.conflicts[0]!.isDirectory).toBe(false);
    expect(plan.conflicts[0]!.destRelPath).toBe('a.txt');
  });

  it('does NOT surface directory conflicts (silent merge)', async () => {
    const src = join(workDir, 'pkg');
    fs.mkdirSync(src);
    fs.writeFileSync(join(src, 'a.txt'), 'hi');
    fs.mkdirSync(join(trustRoot, 'pkg')); // pre-existing dir at dest

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    // Only the file conflict should appear (if any), not the dir.
    for (const c of plan.conflicts) {
      expect(c.isDirectory).toBe(false);
    }
  });
});

// ============================================================================
// Execute — replace / skip / rename
// ============================================================================

describe('executeImport — actions', () => {
  it('replace: overwrites an existing file', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'NEW');
    fs.writeFileSync(join(trustRoot, 'a.txt'), 'OLD');

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    const conflictId = plan.conflicts[0]!.id;
    const report = await executeImport({
      planId: plan.planId,
      resolutions: { [conflictId]: 'replace' },
      onProgress: noProgress,
    });
    expect(report.copiedCount).toBe(1);
    expect(fs.readFileSync(join(trustRoot, 'a.txt'), 'utf8')).toBe('NEW');
  });

  it('skip: leaves an existing file untouched', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'NEW');
    fs.writeFileSync(join(trustRoot, 'a.txt'), 'OLD');

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    const conflictId = plan.conflicts[0]!.id;
    const report = await executeImport({
      planId: plan.planId,
      resolutions: { [conflictId]: 'skip' },
      onProgress: noProgress,
    });
    expect(report.skippedCount).toBe(1);
    expect(fs.readFileSync(join(trustRoot, 'a.txt'), 'utf8')).toBe('OLD');
  });

  it('rename: probes "name (1).ext" for a free target', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'NEW');
    fs.writeFileSync(join(trustRoot, 'a.txt'), 'OLD');

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    const conflictId = plan.conflicts[0]!.id;
    const report = await executeImport({
      planId: plan.planId,
      resolutions: { [conflictId]: 'rename' },
      onProgress: noProgress,
    });
    expect(report.copiedCount).toBe(1);
    expect(fs.readFileSync(join(trustRoot, 'a.txt'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(join(trustRoot, 'a (1).txt'), 'utf8')).toBe('NEW');
  });

  it('default action (no resolution provided) is replace', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'NEW');
    fs.writeFileSync(join(trustRoot, 'a.txt'), 'OLD');

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    const report = await executeImport({
      planId: plan.planId,
      resolutions: {},
      onProgress: noProgress,
    });
    expect(report.copiedCount).toBe(1);
    expect(fs.readFileSync(join(trustRoot, 'a.txt'), 'utf8')).toBe('NEW');
  });
});

// ============================================================================
// Empty dir materialization
// ============================================================================

describe('executeImport — empty dirs', () => {
  it('materializes empty source directories at the destination', async () => {
    const src = join(workDir, 'pkg');
    fs.mkdirSync(src);
    fs.mkdirSync(join(src, 'empty-dir'));

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    await executeImport({
      planId: plan.planId,
      resolutions: {},
      onProgress: noProgress,
    });
    expect(fs.existsSync(join(trustRoot, 'pkg', 'empty-dir'))).toBe(true);
    expect(fs.statSync(join(trustRoot, 'pkg', 'empty-dir')).isDirectory()).toBe(true);
  });
});

// ============================================================================
// Symlinks (Unix only — Windows symlink creation requires admin)
// ============================================================================

(isWindows ? describe.skip : describe)('executeImport — symlinks (unix)', () => {
  it('copies symlinks verbatim, does not follow', async () => {
    const target = join(workDir, 'target.txt');
    fs.writeFileSync(target, 'realfile');
    const link = join(workDir, 'link.txt');
    fs.symlinkSync(target, link);

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [link] });
    expect(plan.summary.symlinkCount).toBe(1);
    await executeImport({
      planId: plan.planId,
      resolutions: {},
      onProgress: noProgress,
    });
    const dest = join(trustRoot, 'link.txt');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dest)).toBe(target);
  });
});

// ============================================================================
// Cancel
// ============================================================================

describe('executeImport — cancel', () => {
  it('stops at the next leaf boundary; partial files remain', async () => {
    const src = join(workDir, 'pkg');
    fs.mkdirSync(src);
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(join(src, `f${i}.txt`), 'x');
    }

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    let frames = 0;
    const reportPromise = executeImport({
      planId: plan.planId,
      resolutions: {},
      onProgress: () => {
        frames++;
        if (frames === 3) cancelImport(plan.planId);
      },
    });
    const report = await reportPromise;
    expect(report.cancelled).toBe(true);
    expect(report.copiedCount).toBeLessThan(20);
    expect(_peekCancelledForTests(plan.planId)).toBe(true);
  });
});

// ============================================================================
// Soft cap warning
// ============================================================================

describe('previewImport — soft cap', () => {
  it('does not warn for small drops', async () => {
    const src = join(workDir, 'a.txt');
    fs.writeFileSync(src, 'x');
    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    expect(plan.summary.warning).toBeUndefined();
  });
});

// ============================================================================
// Progress emit
// ============================================================================

describe('executeImport — progress', () => {
  it('emits one frame per leaf plus a terminal frame', async () => {
    const src = join(workDir, 'pkg');
    fs.mkdirSync(src);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(join(src, `f${i}.txt`), 'x');
    }

    const plan = await previewImport({ trustRoot, destRelDir: '', srcs: [src] });
    const frames: ImportProgressEvent[] = [];
    await executeImport({
      planId: plan.planId,
      resolutions: {},
      onProgress: (e) => frames.push(e),
    });
    expect(frames.length).toBe(plan.summary.fileCount + 1);
    expect(frames[frames.length - 1]!.done).toBe(true);
  });
});
