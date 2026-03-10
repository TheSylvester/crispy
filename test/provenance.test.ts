/**
 * Tests for the Provenance Module
 *
 * Covers scanner, matcher, and store — focused on correctness of the
 * critical paths found during review (heredoc parsing, incremental scanning,
 * commit matching, FTS5 sync, mutation linking).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import {
  extractCommitMessage,
  classifyBashCommand,
  scanProvenanceEntries,
} from '../src/core/provenance/scanner.js';

import { _setTestDir } from '../src/core/activity-index.js';

// ============================================================================
// Test Helpers
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(join(os.tmpdir(), 'provenance-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeTestFile(filename: string, content: string): string {
  const filepath = join(tempDir, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

function makeAssistantEntry(toolUses: object[], extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2025-01-15T10:00:00Z',
    uuid: 'msg-1',
    message: { role: 'assistant', content: toolUses.map(t => ({ type: 'tool_use', ...t })) },
    ...extras,
  });
}

// ============================================================================
// extractCommitMessage — the heredoc fix is critical
// ============================================================================

describe('extractCommitMessage', () => {
  it('extracts from -m "message"', () => {
    expect(extractCommitMessage('git commit -m "feat: add feature"')).toBe('feat: add feature');
  });

  it("extracts from -m 'message'", () => {
    expect(extractCommitMessage("git commit -m 'fix: bug'")).toBe('fix: bug');
  });

  it('extracts from heredoc pattern (regression: was returning garbage)', () => {
    const cmd = `git commit -m "$(cat <<'EOF'
feat: add feature

Co-Authored-By: Claude
EOF
)"`;
    expect(extractCommitMessage(cmd)).toBe('feat: add feature\n\nCo-Authored-By: Claude');
  });

  it('returns null for --amend without -m', () => {
    expect(extractCommitMessage('git commit --amend')).toBeNull();
  });

  it('returns null when no -m flag', () => {
    expect(extractCommitMessage('git commit')).toBeNull();
  });
});

// ============================================================================
// classifyBashCommand — one test per category + null cases
// ============================================================================

describe('classifyBashCommand', () => {
  it.each([
    ['git commit -m "msg"', 'git-commit'],
    ['git checkout main', 'git-branch-op'],
    ['git rebase main', 'git-branch-op'],
    ['git reset --hard HEAD~1', 'git-reset'],
  ])('classifies "%s" as %s', (cmd, category) => {
    expect(classifyBashCommand(cmd)?.category).toBe(category);
  });

  it('extracts file paths from sed -i, rm, mv', () => {
    expect(classifyBashCommand("sed -i 's/foo/bar/g' file.txt")).toEqual({ category: 'file-mutation', filePaths: ['file.txt'] });
    expect(classifyBashCommand('rm file.txt')).toEqual({ category: 'file-deletion', filePaths: ['file.txt'] });
    expect(classifyBashCommand('mv old.txt new.txt')).toEqual({ category: 'file-rename', filePaths: ['old.txt', 'new.txt'] });
  });

  it.each(['git status', 'git log --oneline', 'git diff', 'ls -la', 'echo hello', ''])
    ('returns null for "%s"', (cmd) => {
      expect(classifyBashCommand(cmd)).toBeNull();
    });
});

// ============================================================================
// scanProvenanceEntries — extraction + incremental scanning
// ============================================================================

describe('scanProvenanceEntries', () => {
  it('extracts Edit/Write/Bash mutations and git commit commands', () => {
    const lines = [
      makeAssistantEntry([
        { id: 'e1', name: 'Edit', input: { file_path: '/f1.ts', old_string: 'a', new_string: 'b' } },
        { id: 'w1', name: 'Write', input: { file_path: '/f2.ts' } },
      ], { sessionId: 'sess-1', cwd: '/project' }),
      makeAssistantEntry([
        { id: 'b1', name: 'Bash', input: { command: 'git commit -m "feat: done"' } },
      ]),
    ];
    const filepath = writeTestFile('s.jsonl', lines.join('\n') + '\n');
    const result = scanProvenanceEntries(filepath);

    expect(result.mutations).toHaveLength(3);
    expect(result.mutations[0].tool).toBe('Edit');
    expect(result.mutations[0].oldHash).toBeDefined();
    expect(result.mutations[1].tool).toBe('Write');
    expect(result.mutations[2].tool).toBe('Bash');
    expect(result.mutations[2].bashCategory).toBe('git-commit');
    expect(result.gitCommitCommands).toHaveLength(1);
    expect(result.gitCommitCommands[0].extractedMessage).toBe('feat: done');
    expect(result.sessionId).toBe('sess-1');
    expect(result.cwd).toBe('/project');
  });

  it('skips non-assistant and read-only Bash entries', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      makeAssistantEntry([{ id: 'b1', name: 'Bash', input: { command: 'git status' } }]),
    ];
    const filepath = writeTestFile('s.jsonl', lines.join('\n') + '\n');
    expect(scanProvenanceEntries(filepath).mutations).toHaveLength(0);
  });

  it('supports incremental scanning from offset', () => {
    const line1 = makeAssistantEntry([{ id: 'e1', name: 'Edit', input: { file_path: '/f1.ts' } }]);
    const filepath = writeTestFile('s.jsonl', line1 + '\n');

    const r1 = scanProvenanceEntries(filepath, 0);
    expect(r1.mutations).toHaveLength(1);
    expect(r1.offset).toBe(Buffer.byteLength(line1 + '\n', 'utf-8'));

    // Append and scan from previous offset
    const line2 = makeAssistantEntry([{ id: 'e2', name: 'Edit', input: { file_path: '/f2.ts' } }]);
    fs.appendFileSync(filepath, line2 + '\n');
    const r2 = scanProvenanceEntries(filepath, r1.offset);
    expect(r2.mutations).toHaveLength(1);
    expect(r2.mutations[0].filePath).toBe('/f2.ts');
  });

  it('handles malformed JSON gracefully', () => {
    const valid = makeAssistantEntry([{ id: 'e1', name: 'Edit', input: { file_path: '/ok.ts' } }]);
    const content = [valid, '{"type":"assistant" BROKEN JSON', valid.replace('e1', 'e2')].join('\n') + '\n';
    const filepath = writeTestFile('s.jsonl', content);
    expect(scanProvenanceEntries(filepath).mutations).toHaveLength(2);
  });

  it('returns empty for nonexistent file', () => {
    const result = scanProvenanceEntries('/nonexistent.jsonl');
    expect(result.mutations).toHaveLength(0);
    expect(result.offset).toBe(0);
  });
});

// ============================================================================
// matchCommits — mocked execSync
// ============================================================================

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execSync: vi.fn(original.execSync) };
});

import { execSync } from 'node:child_process';
import { matchCommits } from '../src/core/provenance/matcher.js';
import type { GitCommitCommand } from '../src/core/provenance/types.js';

const mockExecSync = vi.mocked(execSync);

describe('matchCommits', () => {
  afterEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockRestore();
  });
  beforeEach(() => {
    // Re-attach the mock after restore
    vi.mocked(execSync).mockReset();
  });

  const cmd: GitCommitCommand = {
    timestamp: '2025-01-15T10:00:00Z',
    messageUuid: 'msg-1',
    toolUseId: 'tool-1',
    byteOffset: 0,
    command: 'git commit -m "feat: add feature"',
    extractedMessage: 'feat: add feature',
  };

  it('matches exact message at confidence 1.0', () => {
    mockExecSync.mockReturnValue('abc123\nfeat: add feature\nAuthor\n2025-01-15T10:00:05Z\n');
    const result = matchCommits('/repo', [cmd], '/session.jsonl', 'sess-1');
    expect(result).toHaveLength(1);
    expect(result[0].sha).toBe('abc123');
    expect(result[0].matchConfidence).toBe(1.0);
  });

  it('matches prefix at 0.95', () => {
    mockExecSync.mockReturnValue('sha1\nfeat: add feature with extras\nA\n2025-01-15T10:00:05Z\n');
    expect(matchCommits('/repo', [cmd], '/s', null)[0].matchConfidence).toBe(0.95);
  });

  it('matches contains at 0.85', () => {
    mockExecSync.mockReturnValue('sha2\nchore: feat: add feature in module\nA\n2025-01-15T10:00:05Z\n');
    expect(matchCommits('/repo', [cmd], '/s', null)[0].matchConfidence).toBe(0.85);
  });

  it('matches timestamp-only at 0.6', () => {
    mockExecSync.mockReturnValue('sha3\ncompletely different\nA\n2025-01-15T10:00:05Z\n');
    expect(matchCommits('/repo', [cmd], '/s', null)[0].matchConfidence).toBe(0.6);
  });

  it('returns nothing on empty output', () => {
    mockExecSync.mockReturnValue('');
    expect(matchCommits('/repo', [cmd], '/s', null)).toHaveLength(0);
  });

  it('skips commands without timestamp', () => {
    expect(matchCommits('/repo', [{ ...cmd, timestamp: null }], '/s', null)).toHaveLength(0);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('handles execSync errors gracefully', () => {
    mockExecSync.mockImplementation(() => { throw new Error('fail'); });
    expect(matchCommits('/repo', [cmd], '/s', null)).toHaveLength(0);
  });
});

// ============================================================================
// Store — round-trip CRUD, dedup, FTS5, linking
// ============================================================================

import {
  insertMutations,
  insertCommit,
  insertCommitFileChanges,
  linkMutationsToCommit,
  searchCommits,
  loadProvenanceScanStates,
  saveProvenanceScanState,
  getFileMutations,
  getCommitSession,
  getCommitsForEmbedding,
} from '../src/core/provenance/store.js';
import type { RawMutation, MatchedCommit } from '../src/core/provenance/types.js';

describe('provenance store', () => {
  let storeTestDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    storeTestDir = fs.mkdtempSync(join(os.tmpdir(), 'provenance-store-'));
    cleanup = _setTestDir(storeTestDir);
  });

  afterEach(() => {
    cleanup();
    fs.rmSync(storeTestDir, { recursive: true, force: true });
  });

  const mut = (overrides: Partial<RawMutation> = {}): RawMutation => ({
    tool: 'Edit', filePath: '/file.ts', timestamp: '2025-01-15T10:00:00Z',
    messageUuid: 'msg-1', toolUseId: `t-${Math.random().toString(36).slice(2)}`, byteOffset: 0,
    ...overrides,
  });

  const commit = (overrides: Partial<MatchedCommit> = {}): MatchedCommit => ({
    sha: 'abc123', message: 'feat: add feature', author: 'Author',
    authorDate: '2025-01-15T10:00:30Z', repoPath: '/repo',
    sessionFile: '/s.jsonl', sessionId: 'sess-1', messageUuid: 'msg-1', matchConfidence: 1.0,
    ...overrides,
  });

  it('round-trips mutations and deduplicates on (session_file, tool_use_id)', () => {
    const m = mut({ toolUseId: 'dedup-1' });
    insertMutations('/s.jsonl', 'sess-1', [m]);
    insertMutations('/s.jsonl', 'sess-1', [m]); // duplicate
    const results = getFileMutations('/file.ts');
    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('Edit');
    expect(results[0].sessionFile).toBe('/s.jsonl');
  });

  it('round-trips commits and replaces on duplicate SHA', () => {
    insertCommit(commit({ message: 'original' }));
    insertCommit(commit({ message: 'updated' }));
    expect(getCommitSession('abc123')!.message).toBe('updated');
    expect(getCommitSession('nonexistent')).toBeNull();
  });

  it('batch-fetches file changes in getCommitsForEmbedding (N+1 fix)', () => {
    insertCommit(commit());
    insertCommitFileChanges('abc123', [
      { filePath: 'src/a.ts', additions: 10, deletions: 3 },
      { filePath: 'src/b.ts', additions: 5, deletions: 0 },
    ]);
    const results = getCommitsForEmbedding();
    expect(results).toHaveLength(1);
    expect(results[0].files).toHaveLength(2);
    expect(results[0].files[0].additions).toBe(10);
  });

  it('links Edit/Write mutations to commits by time window, excludes Bash and out-of-window', () => {
    insertMutations('/s.jsonl', 'sess-1', [
      mut({ tool: 'Edit', toolUseId: 'in-window', timestamp: '2025-01-15T09:55:00Z' }),
      mut({ tool: 'Edit', toolUseId: 'out-window', timestamp: '2025-01-15T08:00:00Z' }),
      mut({ tool: 'Bash', toolUseId: 'bash-mut', timestamp: '2025-01-15T09:55:00Z', bashCategory: 'file-mutation' }),
    ]);
    linkMutationsToCommit('/s.jsonl', 'sha-1', '2025-01-15T10:00:00Z', '2025-01-15T09:30:00Z');
    const results = getFileMutations('/file.ts');
    const linked = results.filter(r => r.commitSha === 'sha-1');
    expect(linked).toHaveLength(1);
    expect(linked[0].tool).toBe('Edit');
  });

  it('FTS5 search finds commits by message', () => {
    insertCommit(commit({ sha: 's1', message: 'feat: authentication flow' }));
    insertCommit(commit({ sha: 's2', message: 'fix: login bug' }));
    expect(searchCommits('authentication')).toHaveLength(1);
    expect(searchCommits('authentication')[0].sha).toBe('s1');
  });

  it('FTS5 stays in sync after INSERT OR REPLACE', () => {
    insertCommit(commit({ sha: 's1', message: 'old message' }));
    insertCommit(commit({ sha: 's1', message: 'new message' }));
    expect(searchCommits('old')).toHaveLength(0);
    expect(searchCommits('new')).toHaveLength(1);
  });

  it('round-trips scan state', () => {
    saveProvenanceScanState({ filePath: '/a.jsonl', mtime: 1000, size: 500, byteOffset: 250 });
    const states = loadProvenanceScanStates();
    expect(states.get('/a.jsonl')).toEqual({ filePath: '/a.jsonl', mtime: 1000, size: 500, byteOffset: 250 });
  });
});
