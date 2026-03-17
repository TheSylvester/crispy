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
import type { SessionInfo } from '../agent-adapter.js';
import { log } from '../log.js';

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

/**
 * Run a full provenance scan across all sessions.
 *
 * Phase 1: Scan JSONL files for Edit/Write/Bash tool_uses
 * Phase 2: Match git commit commands to actual commits
 * Phase 3: Save scan state for incremental scanning
 *
 * Called after the main activity scan.
 */
export function runProvenanceScan(sessions: SessionInfo[]): void {
  const scanStates = loadProvenanceScanStates();

  // Collect git commit commands grouped by repo path
  const repoCommitCommands = new Map<string, { commands: GitCommitCommand[]; sessionFile: string; sessionId: string | null }[]>();

  // Deferred scan state saves — files with commit commands save AFTER Phase 2
  // to avoid losing commit attribution if Phase 2 fails or process crashes.
  const deferredScanStates: Array<{ filePath: string; mtime: number; size: number; byteOffset: number }> = [];

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
      const sessionId = result.sessionId ?? session.sessionId ?? null;

      // Store mutations
      if (result.mutations.length > 0) {
        insertMutations(session.path, sessionId, result.mutations);
      }

      const scanState = { filePath: session.path, mtime, size, byteOffset: result.offset };

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
            sessionId,
          });
        }
        // Defer state save until after Phase 2 matching
        deferredScanStates.push(scanState);
      } else {
        // No commit commands — safe to save immediately
        saveProvenanceScanState(scanState);
      }
    } catch (err) {
      log({ level: 'error', source: 'provenance', summary: `Error scanning ${session.path}: ${err instanceof Error ? err.message : String(err)}`, data: { path: session.path, error: String(err) } });
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
            const cmd = group.commands.find(c => c.messageUuid === commit.messageUuid);
            if (cmd?.timestamp) {
              const windowStart = new Date(new Date(cmd.timestamp).getTime() - 30 * 60_000).toISOString();
              linkMutationsToCommit(group.sessionFile, commit.sha, cmd.timestamp, windowStart);
            }
          }
        }
      } catch (err) {
        log({ level: 'error', source: 'provenance', summary: `Error matching commits in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`, data: { repoPath, error: String(err) } });
      }
    }

    // Save repo HEAD state — once per repo, not per session group
    try {
      const head = execSync('git rev-parse HEAD', {
        cwd: repoPath, timeout: 5000, encoding: 'utf-8',
      }).trim();
      saveRepoState(repoPath, head);
    } catch { /* skip */ }
  }

  // Phase 3: Save deferred scan states (after Phase 2 succeeded)
  for (const state of deferredScanStates) {
    saveProvenanceScanState(state);
  }
}
