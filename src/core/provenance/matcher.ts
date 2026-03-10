/**
 * Provenance Matcher — Link git commit tool_uses to actual commits
 *
 * For each `git commit` Bash command found in a transcript, queries the
 * repo's git log in a narrow time window and matches by commit message.
 * Uses execSync with timeout for safety.
 *
 * @module provenance/matcher
 */

import { execSync } from 'node:child_process';
import type { GitCommitCommand, MatchedCommit, CommitFileChange } from './types.js';

/**
 * Match git commit commands against actual git history.
 *
 * For each commit command, queries git log in a -30s/+60s window around
 * the transcript timestamp and matches by message similarity.
 */
export function matchCommits(
  repoPath: string,
  commitCommands: GitCommitCommand[],
  sessionFile: string,
  sessionId: string | null,
): MatchedCommit[] {
  const matched: MatchedCommit[] = [];

  for (const cmd of commitCommands) {
    if (!cmd.timestamp) continue;

    try {
      const ts = new Date(cmd.timestamp);
      const before = new Date(ts.getTime() + 60_000).toISOString();
      const after = new Date(ts.getTime() - 30_000).toISOString();

      const output = execSync(
        `git log --format="%H%n%s%n%aN%n%aI%n" --after="${after}" --before="${before}"`,
        { cwd: repoPath, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();

      if (!output) continue;

      // Parse 4-line groups (sha, subject, author, date) separated by blank lines
      const lines = output.split('\n');
      const candidates: Candidate[] = [];
      for (let i = 0; i + 3 <= lines.length; i += 5) {
        candidates.push({
          sha: lines[i]!,
          subject: lines[i + 1]!,
          author: lines[i + 2]!,
          date: lines[i + 3]!,
        });
      }

      // Try to match by message
      const best = findBestMatch(candidates, cmd.extractedMessage);
      if (!best) continue;

      matched.push({
        sha: best.sha,
        message: best.subject,
        author: best.author,
        authorDate: best.date,
        repoPath,
        sessionFile,
        sessionId,
        messageUuid: cmd.messageUuid,
        matchConfidence: best.confidence,
      });
    } catch {
      // git log failed — skip this commit
      continue;
    }
  }

  return matched;
}

interface Candidate {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

interface Match extends Candidate {
  confidence: number;
}

function findBestMatch(candidates: Candidate[], extractedMessage: string | null): Match | null {
  if (candidates.length === 0) return null;

  if (extractedMessage) {
    const normalized = extractedMessage.trim();

    // Exact match
    for (const c of candidates) {
      if (c.subject === normalized) {
        return { ...c, confidence: 1.0 };
      }
    }

    // First-line match (extracted message may be multi-line)
    const firstLine = normalized.split('\n')[0]!.trim();
    for (const c of candidates) {
      if (c.subject === firstLine) {
        return { ...c, confidence: 1.0 };
      }
    }

    // Prefix match
    for (const c of candidates) {
      if (c.subject.startsWith(firstLine) || firstLine.startsWith(c.subject)) {
        return { ...c, confidence: 0.95 };
      }
    }

    // Contains match
    for (const c of candidates) {
      if (c.subject.includes(firstLine) || firstLine.includes(c.subject)) {
        return { ...c, confidence: 0.85 };
      }
    }
  }

  // Timestamp-only match — only if single candidate
  if (candidates.length === 1) {
    return { ...candidates[0]!, confidence: 0.6 };
  }

  return null;
}

/**
 * Get per-file changes for a commit using git diff --numstat.
 */
export function getCommitFileChanges(repoPath: string, sha: string): CommitFileChange[] {
  try {
    const output = execSync(
      `git diff --numstat ${sha}~1 ${sha}`,
      { cwd: repoPath, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const [add, del, file] = line.split('\t');
      return {
        filePath: file || '',
        additions: parseInt(add || '0', 10) || 0,
        deletions: parseInt(del || '0', 10) || 0,
      };
    }).filter(c => c.filePath);
  } catch {
    return [];
  }
}
