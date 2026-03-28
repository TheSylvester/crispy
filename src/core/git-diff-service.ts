/**
 * Git Diff Service — retrieves working tree diff data via git CLI
 *
 * Shells out to `git diff` and `git ls-files` using execFile (no shell)
 * to collect staged changes, unstaged changes, and untracked files.
 * Results are parsed into structured types via git-diff-parser.
 *
 * @module git-diff-service
 */

import { execFile } from "node:child_process";
import { parseUnifiedDiff, type ParsedDiff } from "./git-diff-parser.js";
import { log } from "./log.js";

export interface GitDiffResult {
  files: ParsedDiff[];
  staged: ParsedDiff[];
  untracked: string[];
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) {
        // git diff exits with 0 on success but some commands exit 1 for
        // "changes found" — only reject on actual failures
        if (err.code && typeof err.code === 'number' && err.code > 1) {
          reject(err);
          return;
        }
        // Exit code 1 with stdout content means diff found changes — that's OK
        if (stdout) {
          resolve(stdout);
          return;
        }
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Get the full git diff result for a working directory:
 * unstaged changes, staged changes, and untracked file paths.
 */
export async function getGitDiff(cwd: string): Promise<GitDiffResult> {
  const empty: GitDiffResult = { files: [], staged: [], untracked: [] };

  try {
    const [unstaged, staged, untrackedRaw] = await Promise.all([
      runGit(["diff", "--patch", "--no-color", "--find-renames"], cwd).catch(() => ""),
      runGit(["diff", "--staged", "--patch", "--no-color", "--find-renames"], cwd).catch(() => ""),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd).catch(() => ""),
    ]);

    return {
      files: parseUnifiedDiff(unstaged),
      staged: parseUnifiedDiff(staged),
      untracked: untrackedRaw.split("\0").filter(Boolean),
    };
  } catch (err) {
    log({ level: "warn", source: "git-diff-service", summary: `Failed to get git diff: ${err}` });
    return empty;
  }
}
