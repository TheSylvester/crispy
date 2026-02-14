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
 * List all tracked + untracked (non-ignored) files via git.
 *
 * Uses `execFile` (no shell) to avoid injection. 10MB maxBuffer
 * accommodates large repos.
 */
export function getGitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          stdout
            .split("\n")
            .filter((line) => line.length > 0),
        );
      },
    );
  });
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
