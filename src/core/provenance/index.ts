/**
 * Provenance Index — Public API and Scan Orchestrator
 *
 * Re-exports query functions for recall integration and provides
 * runProvenanceScan() for the activity scanner to call.
 *
 * @module provenance/index
 */

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { scanProvenanceEntries } from './scanner.js';
import { matchCommits, getCommitFileChanges } from './matcher.js';
import {
  insertMutations,
  insertCommit,
  insertCommitFileChanges,
  linkMutationsToCommit,
  loadProvenanceScanStates,
  saveProvenanceScanState,
  saveRepoState,
} from './store.js';
import type { GitCommitCommand } from './types.js';

// Re-export query functions for recall consumers
export {
  getCommitSession,
  getSessionCommits,
  getFileMutations,
  getUncommittedMutations,
  searchCommits,
  getCommitsForEmbedding,
  getRecentMutations,
} from './store.js';

// Re-export types
export type {
  CommitSession,
  FileMutationRecord,
  CommitForEmbedding,
  MatchedCommit,
  CommitFileChange,
} from './types.js';

interface SessionInfo {
  path?: string;
  projectPath?: string;
}

/**
 * Run a full provenance scan across all sessions.
 *
 * Phase 1: Scan JSONL files for Edit/Write/Bash tool_uses
 * Phase 2: Match git commit commands to actual commits
 * Phase 3: Save scan state for incremental scanning
 *
 * Called by activity-scanner.ts after the main activity scan.
 */
export function runProvenanceScan(sessions: SessionInfo[]): void {
  const scanStates = loadProvenanceScanStates();

  // Collect git commit commands grouped by repo path
  const repoCommitCommands = new Map<string, { commands: GitCommitCommand[]; sessionFile: string; sessionId: string | null }[]>();

  // Phase 1: Scan JSONL files
  for (const session of sessions) {
    if (!session.path) continue;

    try {
      const stat = fs.statSync(session.path);
      const cached = scanStates.get(session.path);
      const mtime = stat.mtimeMs;
      const size = stat.size;

      // Skip unchanged files
      if (cached && cached.mtime === mtime && cached.size === size) {
        continue;
      }

      // Reset offset on truncation
      let fromOffset = cached?.byteOffset ?? 0;
      if (cached && size < cached.size) {
        fromOffset = 0;
      }

      const result = scanProvenanceEntries(session.path, fromOffset);

      // Store mutations
      if (result.mutations.length > 0) {
        insertMutations(session.path, result.sessionId, result.mutations);
      }

      // Collect git commit commands for Phase 2
      if (result.gitCommitCommands.length > 0) {
        const repoPath = session.projectPath || result.cwd;
        if (repoPath) {
          if (!repoCommitCommands.has(repoPath)) {
            repoCommitCommands.set(repoPath, []);
          }
          repoCommitCommands.get(repoPath)!.push({
            commands: result.gitCommitCommands,
            sessionFile: session.path,
            sessionId: result.sessionId,
          });
        }
      }

      // Save scan state
      saveProvenanceScanState({
        filePath: session.path,
        mtime,
        size,
        byteOffset: result.offset,
      });
    } catch (err) {
      console.error(`[provenance] Error scanning ${session.path}:`, err);
    }
  }

  // Phase 2: Match commits per repo
  for (const [repoPath, sessionGroups] of repoCommitCommands) {
    for (const group of sessionGroups) {
      try {
        const matched = matchCommits(repoPath, group.commands, group.sessionFile, group.sessionId);

        for (const commit of matched) {
          insertCommit(commit);

          // Get file changes
          const fileChanges = getCommitFileChanges(repoPath, commit.sha);
          if (fileChanges.length > 0) {
            insertCommitFileChanges(commit.sha, fileChanges);
          }

          // Link preceding Edit/Write mutations to this commit
          if (commit.messageUuid) {
            // Find the commit command's timestamp to define the window
            const cmd = group.commands.find(c => c.messageUuid === commit.messageUuid);
            if (cmd?.timestamp) {
              // Link mutations from up to 30 minutes before the commit
              const commitTs = new Date(cmd.timestamp);
              const windowStart = new Date(commitTs.getTime() - 30 * 60_000).toISOString();
              linkMutationsToCommit(group.sessionFile, commit.sha, cmd.timestamp, windowStart);
            }
          }
        }

        // Save repo HEAD state
        try {
          const head = execSync('git rev-parse HEAD', {
            cwd: repoPath, timeout: 5000, encoding: 'utf-8',
          }).trim();
          saveRepoState(repoPath, head);
        } catch { /* skip */ }
      } catch (err) {
        console.error(`[provenance] Error matching commits in ${repoPath}:`, err);
      }
    }
  }
}
