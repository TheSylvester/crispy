/**
 * Git Diff Parser — parses unified diff format into structured types
 *
 * Converts raw `git diff` stdout into an array of ParsedDiff objects,
 * each containing file metadata, hunks with line-level detail, and
 * aggregate add/remove stats. Handles renames, binary files, and
 * no-newline-at-EOF markers.
 *
 * @module git-diff-parser
 */

export interface HunkLine {
  type: 'context' | 'added' | 'removed';
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface ParsedDiff {
  filePath: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  stats: { added: number; removed: number };
}

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse raw unified diff output into structured ParsedDiff objects.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff[] {
  if (!raw.trim()) return [];

  const lines = raw.split('\n');
  const results: ParsedDiff[] = [];
  let current: ParsedDiff | null = null;
  let currentHunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file diff header
    const headerMatch = DIFF_HEADER.exec(line);
    if (headerMatch) {
      if (current) results.push(current);
      current = {
        filePath: headerMatch[2],
        oldPath: null,
        status: 'modified',
        binary: false,
        hunks: [],
        stats: { added: 0, removed: 0 },
      };
      currentHunk = null;
      continue;
    }

    if (!current) continue;

    // Rename detection
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice(12);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.filePath = line.slice(10);
      continue;
    }
    if (line.startsWith('similarity index')) {
      continue;
    }

    // File markers — detect add/delete
    if (line.startsWith('--- ')) {
      if (line === '--- /dev/null') {
        current.status = 'added';
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') {
        current.status = 'deleted';
      }
      continue;
    }

    // Binary file
    if (line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }

    // Index/mode/new file mode headers — skip
    if (line.startsWith('index ') || line.startsWith('old mode ') ||
        line.startsWith('new mode ') || line.startsWith('new file mode ') ||
        line.startsWith('deleted file mode ') || line.startsWith('dissimilarity index ')) {
      continue;
    }

    // Hunk header
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    // No newline at EOF marker — skip
    if (line === '\\ No newline at end of file') {
      continue;
    }

    // Content lines
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'added', text: line.slice(1), oldLineNo: null, newLineNo: newLine++ });
      current.stats.added++;
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'removed', text: line.slice(1), oldLineNo: oldLine++, newLineNo: null });
      current.stats.removed++;
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: 'context', text: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    }
  }

  if (current) results.push(current);

  return results;
}
