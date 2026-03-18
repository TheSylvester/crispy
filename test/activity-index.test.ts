/**
 * Tests for Activity Index
 *
 * Tests the SQLite-backed persistence layer for user activity data:
 * - Activity entries CRUD (appendActivityEntries, queryActivity)
 * - Error handling for edge cases
 * - Dedup via UNIQUE constraint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import {
  ensureCrispyDir,
  appendActivityEntries,
  queryActivity,
  _setTestDir,
  type ActivityIndexEntry,
} from '../src/core/activity-index.js';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;
let cleanup: () => void;

beforeEach(() => {
  // Create isolated temp directory for each test
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-test-'));
  cleanup = _setTestDir(testDir);
});

afterEach(() => {
  cleanup();
  // Clean up temp directory
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Helper Functions
// ============================================================================

/** Read all activity entries via the public API. */
function readActivityEntries(): ActivityIndexEntry[] {
  return queryActivity();
}

// ============================================================================
// ensureCrispyDir
// ============================================================================

describe('ensureCrispyDir', () => {
  it('creates directory if it does not exist', () => {
    fs.rmSync(testDir, { recursive: true, force: true });
    expect(fs.existsSync(testDir)).toBe(false);

    ensureCrispyDir();
    expect(fs.existsSync(testDir)).toBe(true);
  });

  it('is idempotent when directory exists', () => {
    ensureCrispyDir();
    ensureCrispyDir();
    expect(fs.existsSync(testDir)).toBe(true);
  });
});

// ============================================================================
// appendActivityEntries
// ============================================================================

describe('appendActivityEntries', () => {
  it('stores entries retrievable by queryActivity', () => {
    const entry: ActivityIndexEntry = {
      ts: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'Hello world',
    };

    appendActivityEntries([entry]);

    const entries = readActivityEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual(entry);
  });

  it('accumulates entries across multiple calls', () => {
    const entry1: ActivityIndexEntry = {
      ts: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/a.jsonl',
      preview: 'First',
    };
    const entry2: ActivityIndexEntry = {
      ts: '2025-01-15T11:00:00Z',
      kind: 'prompt',
      file: '/b.jsonl',
      preview: 'Second',
    };

    appendActivityEntries([entry1]);
    appendActivityEntries([entry2]);

    const entries = readActivityEntries();
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual(entry1);
    expect(entries[1]).toEqual(entry2);
  });

  it('writes multiple entries in one call', () => {
    const entries: ActivityIndexEntry[] = [
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A' },
      { ts: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B' },
      { ts: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C' },
    ];

    appendActivityEntries(entries);

    const result = readActivityEntries();
    expect(result.length).toBe(3);
  });

  it('is a no-op when entries array is empty', () => {
    appendActivityEntries([]);

    const result = readActivityEntries();
    expect(result).toEqual([]);
  });

  it('deduplicates entries with same file+ts+kind', () => {
    const entry: ActivityIndexEntry = {
      ts: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'Hello world',
    };

    appendActivityEntries([entry]);
    appendActivityEntries([entry]); // Duplicate — should be ignored

    const entries = readActivityEntries();
    expect(entries.length).toBe(1);
  });

  it('preserves session_id field when present', () => {
    const entry: ActivityIndexEntry = {
      ts: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'With session ID',
      session_id: 'sess-abc-123',
    };

    appendActivityEntries([entry]);

    const entries = readActivityEntries();
    expect(entries[0]!.session_id).toBe('sess-abc-123');
  });

  it('preserves model and cwd fields when present', () => {
    const entry: ActivityIndexEntry = {
      ts: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'With extras',
      model: 'claude-haiku-4-5',
      cwd: '/home/user/project',
    };

    appendActivityEntries([entry]);

    const entries = readActivityEntries();
    expect(entries[0]!.model).toBe('claude-haiku-4-5');
    expect(entries[0]!.cwd).toBe('/home/user/project');
  });
});

// ============================================================================
// queryActivity
// ============================================================================

describe('queryActivity', () => {
  it('returns empty array when database is empty', () => {
    const result = queryActivity();
    expect(result).toEqual([]);
  });

  it('returns all entries sorted by ts ascending', () => {
    appendActivityEntries([
      { ts: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C' },
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A' },
      { ts: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B' },
    ]);

    const result = queryActivity();
    expect(result.length).toBe(3);
    expect(result[0]!.preview).toBe('A');
    expect(result[1]!.preview).toBe('B');
    expect(result[2]!.preview).toBe('C');
  });

  it('filters by from timestamp', () => {
    appendActivityEntries([
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A' },
      { ts: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B' },
      { ts: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C' },
    ]);

    const result = queryActivity({ from: '2025-01-15T11:00:00Z' });
    expect(result.length).toBe(2);
    expect(result[0]!.preview).toBe('B');
    expect(result[1]!.preview).toBe('C');
  });

  it('filters by to timestamp', () => {
    appendActivityEntries([
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A' },
      { ts: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B' },
      { ts: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C' },
    ]);

    const result = queryActivity({ to: '2025-01-15T11:00:00Z' });
    expect(result.length).toBe(2);
    expect(result[0]!.preview).toBe('A');
    expect(result[1]!.preview).toBe('B');
  });

  it('filters by both from and to timestamps', () => {
    appendActivityEntries([
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A' },
      { ts: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B' },
      { ts: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C' },
    ]);

    const result = queryActivity({ from: '2025-01-15T10:30:00Z', to: '2025-01-15T11:30:00Z' });
    expect(result.length).toBe(1);
    expect(result[0]!.preview).toBe('B');
  });

  it('filters by kind', () => {
    appendActivityEntries([
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'Prompt' },
    ]);

    const prompts = queryActivity(undefined, 'prompt');
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.preview).toBe('Prompt');
  });

  it('does not include session_id when entry has no session_id', () => {
    appendActivityEntries([
      { ts: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A' },
    ]);

    const result = queryActivity();
    expect(result[0]!.session_id).toBeUndefined();
  });
});
