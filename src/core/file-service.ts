/**
 * File Service — backend file operations for linkification
 *
 * Pure Node.js functions (no VS Code dependency) that work in both
 * dev-server and extension environments.
 *
 * @module file-service
 */

import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/**
 * Gitignored directories whose contents should still appear in the file index
 * (for linkification and @-mention autocomplete). These are listed via a
 * separate `git ls-files --others --ignored` scoped to each path, then merged
 * with the main listing.
 */
const EXTRA_INDEX_DIRS = [".ai-reference"];

/** Run `git ls-files` with the given args and return non-empty lines. */
function lsFiles(args: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.split("\n").filter((line) => line.length > 0));
      },
    );
  });
}

/**
 * List all tracked + untracked (non-ignored) files via git, plus files in
 * {@link EXTRA_INDEX_DIRS} even if gitignored.
 *
 * Uses `execFile` (no shell) to avoid injection. 10MB maxBuffer
 * accommodates large repos.
 */
export async function getGitFiles(cwd: string): Promise<string[]> {
  const main = await lsFiles(
    ["--cached", "--others", "--exclude-standard"],
    cwd,
  );

  // Collect gitignored files from allowlisted dirs. Failures (e.g. dir
  // doesn't exist) are silently ignored — these are optional extras.
  const extras = await Promise.all(
    EXTRA_INDEX_DIRS.map((dir) =>
      lsFiles(
        ["--others", "--ignored", "--exclude-standard", "--", dir],
        cwd,
      ).catch(() => [] as string[]),
    ),
  );

  const seen = new Set(main);
  for (const list of extras) {
    for (const file of list) {
      if (!seen.has(file)) {
        seen.add(file);
        main.push(file);
      }
    }
  }

  return main;
}

/**
 * Check if a path points to an existing file (not directory).
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

// ============================================================================
// Image Reading
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Read an image file and return its base64-encoded data with MIME type.
 *
 * @param filePath - Absolute path to the image file
 * @returns Base64-encoded data, detected MIME type, and file name
 * @throws If the path is not a file, exceeds MAX_IMAGE_SIZE, or is unreadable
 */
export async function readImage(filePath: string): Promise<{ data: string; mimeType: string; fileName: string }> {
  const s = await stat(filePath);
  if (!s.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (s.size > MAX_IMAGE_SIZE) throw new Error(`File too large: ${s.size} bytes (max ${MAX_IMAGE_SIZE})`);

  const buffer = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();

  return {
    data: buffer.toString('base64'),
    mimeType: MIME_TYPES[ext] ?? 'application/octet-stream',
    fileName: basename(filePath),
  };
}
