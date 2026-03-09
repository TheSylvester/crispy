/**
 * Provenance Types — Interfaces for file mutations, commits, and query results
 *
 * Vendor-agnostic types for the git provenance index. Used by scanner,
 * matcher, store, and query consumers.
 *
 * @module provenance/types
 */

/** Raw mutation extracted from a JSONL transcript */
export interface RawMutation {
  tool: 'Edit' | 'Write' | 'Bash';
  bashCategory?: BashCategory;
  filePath: string | null;
  timestamp: string | null;
  messageUuid: string | null;
  toolUseId: string;
  byteOffset: number;
  command?: string;
  oldHash?: string;
  newHash?: string;
}

export type BashCategory =
  | 'git-commit'
  | 'git-branch-op'
  | 'git-reset'
  | 'file-mutation'
  | 'file-deletion'
  | 'file-rename';

/** A git commit Bash command extracted from a transcript */
export interface GitCommitCommand {
  timestamp: string | null;
  messageUuid: string | null;
  toolUseId: string;
  byteOffset: number;
  command: string;
  extractedMessage: string | null;
}

/** Result from scanning a single JSONL file */
export interface ScanResult {
  mutations: RawMutation[];
  gitCommitCommands: GitCommitCommand[];
  offset: number;
  sessionId: string | null;
  cwd: string | null;
}

/** A matched git commit */
export interface MatchedCommit {
  sha: string;
  message: string;
  author: string | null;
  authorDate: string;
  repoPath: string;
  sessionFile: string | null;
  sessionId: string | null;
  messageUuid: string | null;
  matchConfidence: number;
}

/** File change in a commit */
export interface CommitFileChange {
  filePath: string;
  additions: number;
  deletions: number;
}

/** Query result: commit -> session attribution */
export interface CommitSession {
  sha: string;
  message: string;
  authorDate: string;
  sessionFile: string | null;
  sessionId: string | null;
  matchConfidence: number;
}

/** Query result: file mutation history */
export interface FileMutationRecord {
  sessionFile: string;
  sessionId: string | null;
  tool: string;
  bashCategory: string | null;
  filePath: string | null;
  timestamp: string | null;
  commitSha: string | null;
  command: string | null;
}

/** Scan state for incremental scanning */
export interface ProvenanceScanState {
  filePath: string;
  mtime: number;
  size: number;
  byteOffset: number;
}

/** Commit data prepared for external embedding */
export interface CommitForEmbedding {
  sha: string;
  message: string;
  authorDate: string;
  repoPath: string;
  sessionFile: string | null;
  sessionId: string | null;
  files: CommitFileChange[];
}
