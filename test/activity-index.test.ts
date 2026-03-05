/**
 * Tests for Activity Index
 *
 * Tests the SQLite-backed persistence layer for user activity data:
 * - Scan state CRUD (loadScanState, saveScanState)
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
  loadScanState,
  saveScanState,
  appendActivityEntries,
  queryActivity,
  _setTestDir,
  type ActivityIndexEntry,
  type ScanState,
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
// loadScanState
// ============================================================================

describe('loadScanState', () => {
  it('returns default state when database is empty', () => {
    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns saved state after saveScanState', () => {
    const expected: ScanState = {
      version: 1,
      files: {
        '/path/to/session.jsonl': { mtime: 1234567890, size: 1024, offset: 512 },
      },
    };
    saveScanState(expected);

    const state = loadScanState();
    expect(state).toEqual(expected);
  });
});

// ============================================================================
// saveScanState
// ============================================================================

describe('saveScanState', () => {
  it('writes state readable by loadScanState', () => {
    const state: ScanState = {
      version: 1,
      files: {
        '/a.jsonl': { mtime: 100, size: 50, offset: 25 },
        '/b.jsonl': { mtime: 200, size: 100, offset: 75 },
      },
    };

    saveScanState(state);

    const loaded = loadScanState();
    expect(loaded).toEqual(state);
  });

  it('creates directory if it does not exist', () => {
    fs.rmSync(testDir, { recursive: true, force: true });
    expect(fs.existsSync(testDir)).toBe(false);

    saveScanState({ version: 1, files: {} });

    expect(fs.existsSync(testDir)).toBe(true);
    expect(loadScanState()).toEqual({ version: 1, files: {} });
  });

  it('overwrites existing state', () => {
    saveScanState({ version: 1, files: { '/old.jsonl': { mtime: 1, size: 1, offset: 1 } } });
    saveScanState({ version: 1, files: { '/new.jsonl': { mtime: 2, size: 2, offset: 2 } } });

    const loaded = loadScanState();
    expect(loaded.files).toEqual({ '/new.jsonl': { mtime: 2, size: 2, offset: 2 } });
  });
});

// ============================================================================
// appendActivityEntries
// ============================================================================

describe('appendActivityEntries', () => {
  it('stores entries retrievable by queryActivity', () => {
    const entry: ActivityIndexEntry = {
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'Hello world',
      offset: 0,
    };

    appendActivityEntries([entry]);

    const entries = readActivityEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual(entry);
  });

  it('accumulates entries across multiple calls', () => {
    const entry1: ActivityIndexEntry = {
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/a.jsonl',
      preview: 'First',
      offset: 0,
    };
    const entry2: ActivityIndexEntry = {
      timestamp: '2025-01-15T11:00:00Z',
      kind: 'prompt',
      file: '/b.jsonl',
      preview: 'Second',
      offset: 100,
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
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 },
      { timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 },
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

  it('preserves uuid field when present', () => {
    const entry: ActivityIndexEntry = {
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'With UUID',
      offset: 0,
      uuid: 'msg-abc-123',
    };

    appendActivityEntries([entry]);

    const entries = readActivityEntries();
    expect(entries[0].uuid).toBe('msg-abc-123');
  });

  it('deduplicates entries with same timestamp+file+uuid', () => {
    const entry: ActivityIndexEntry = {
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'Hello world',
      offset: 0,
      uuid: 'msg-abc-123',
    };

    appendActivityEntries([entry]);
    appendActivityEntries([entry]); // Duplicate — should be ignored

    const entries = readActivityEntries();
    expect(entries.length).toBe(1);
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

  it('returns all entries sorted by timestamp ascending', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 },
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 },
    ]);

    const result = queryActivity();
    expect(result.length).toBe(3);
    expect(result[0].preview).toBe('A');
    expect(result[1].preview).toBe('B');
    expect(result[2].preview).toBe('C');
  });

  it('filters by from timestamp', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 },
      { timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 },
    ]);

    const result = queryActivity({ from: '2025-01-15T11:00:00Z' });
    expect(result.length).toBe(2);
    expect(result[0].preview).toBe('B');
    expect(result[1].preview).toBe('C');
  });

  it('filters by to timestamp', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 },
      { timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 },
    ]);

    const result = queryActivity({ to: '2025-01-15T11:00:00Z' });
    expect(result.length).toBe(2);
    expect(result[0].preview).toBe('A');
    expect(result[1].preview).toBe('B');
  });

  it('filters by both from and to timestamps', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 },
      { timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 },
    ]);

    const result = queryActivity({ from: '2025-01-15T10:30:00Z', to: '2025-01-15T11:30:00Z' });
    expect(result.length).toBe(1);
    expect(result[0].preview).toBe('B');
  });

  it('filters by kind', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'Prompt', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'rosie-meta', file: '/b.jsonl', preview: 'Meta', offset: 0 },
    ]);

    const prompts = queryActivity(undefined, 'prompt');
    expect(prompts.length).toBe(1);
    expect(prompts[0].preview).toBe('Prompt');

    const metas = queryActivity(undefined, 'rosie-meta');
    expect(metas.length).toBe(1);
    expect(metas[0].preview).toBe('Meta');
  });

  it('preserves uuid in returned entries', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0, uuid: 'abc-123' },
    ]);

    const result = queryActivity();
    expect(result[0].uuid).toBe('abc-123');
  });

  it('does not include uuid when entry has no uuid', () => {
    appendActivityEntries([
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
    ]);

    const result = queryActivity();
    expect(result[0].uuid).toBeUndefined();
  });

  it('persists and retrieves rosie-meta fields including status', () => {
    appendActivityEntries([{
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'rosie-meta',
      file: '/session.jsonl',
      preview: 'Build the tracker',
      offset: 0,
      quest: 'Build the project tracker MVP',
      summary: 'User asked to implement the tracker. I created the schema.',
      title: 'Project Tracker Implementation',
      status: 'Schema created. Hook wiring in progress. Tests pending.',
    }]);

    const result = queryActivity(undefined, 'rosie-meta');
    expect(result.length).toBe(1);
    expect(result[0].quest).toBe('Build the project tracker MVP');
    expect(result[0].summary).toBe('User asked to implement the tracker. I created the schema.');
    expect(result[0].title).toBe('Project Tracker Implementation');
    expect(result[0].status).toBe('Schema created. Hook wiring in progress. Tests pending.');
  });

  it('returns undefined status when not provided', () => {
    appendActivityEntries([{
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'rosie-meta',
      file: '/session.jsonl',
      preview: 'Goal text',
      offset: 0,
      quest: 'Some goal',
      summary: 'Some summary',
      title: 'Some title',
    }]);

    const result = queryActivity(undefined, 'rosie-meta');
    expect(result[0].status).toBeUndefined();
  });
});
