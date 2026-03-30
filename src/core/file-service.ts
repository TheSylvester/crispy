/**
 * File Service — backend file operations for linkification and file reading
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
 *
 * `.claude/commands` and `.claude/skills` are always gitignored but contain
 * user-authored content that should be browsable and @-mentionable.
 */
const EXTRA_INDEX_DIRS = [".ai-reference", ".claude/commands", ".claude/skills"];

/**
 * Run `git ls-files` with the given args and return non-empty entries.
 *
 * Uses `-z` for NUL-delimited output so filenames containing non-ASCII
 * characters (emoji, accented letters) are returned verbatim instead of
 * octal-escaped (git's default `core.quotePath` behavior).
 */
function lsFiles(args: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "-z", ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.split("\0").filter((entry) => entry.length > 0));
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
 * Get current git branch name and dirty status for the given working directory.
 *
 * Returns `null` if `cwd` is not inside a git repo. For detached HEAD,
 * returns the short SHA instead of a branch name.
 */
export async function getGitBranchInfo(
  cwd: string,
): Promise<{ branch: string; dirty: boolean } | null> {
  try {
    const branch = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
    });

    // Detached HEAD — rev-parse returns literal "HEAD"
    const displayBranch =
      branch === "HEAD"
        ? await new Promise<string>((resolve, reject) => {
            execFile(
              "git",
              ["rev-parse", "--short", "HEAD"],
              { cwd, windowsHide: true },
              (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
            );
          })
        : branch;

    const porcelain = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["status", "--porcelain"],
        { cwd, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });

    return { branch: displayBranch, dirty: porcelain.length > 0 };
  } catch {
    return null;
  }
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

// ============================================================================
// Text File Reading
// ============================================================================

const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5MB

/** Known binary extensions that should not be read as text */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.wasm', '.so', '.dylib',
]);

/**
 * Read a text file and return its content, name, and size.
 *
 * Refuses binary files (by extension) and files over MAX_TEXT_SIZE.
 * Caller is responsible for path containment validation.
 *
 * @param filePath - Absolute path to the text file
 * @returns Content string, basename, and byte size
 * @throws If binary extension, not a file, too large, or unreadable
 */
export async function readTextFile(
  filePath: string,
): Promise<{ content: string; fileName: string; size: number }> {
  const ext = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new Error(`Binary file type: ${ext}`);
  }

  const s = await stat(filePath);
  if (!s.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (s.size > MAX_TEXT_SIZE) throw new Error(`File too large: ${s.size} bytes (max ${MAX_TEXT_SIZE})`);

  const buffer = await readFile(filePath, 'utf-8');
  return {
    content: buffer,
    fileName: basename(filePath),
    size: s.size,
  };
}
