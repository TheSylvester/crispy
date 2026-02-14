/**
 * File Service — backend file operations for linkification
 *
 * Pure Node.js functions (no VS Code dependency) that work in both
 * dev-server and extension environments.
 *
 * @module file-service
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

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
