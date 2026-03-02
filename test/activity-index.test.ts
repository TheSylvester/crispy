/**
 * Tests for Activity Index
 *
 * Tests the persistence layer for user activity data:
 * - Scan state CRUD (loadScanState, saveScanState)
 * - Activity entries CRUD (appendActivityEntries, queryActivity)
 * - Atomic write pattern
 * - Error handling for malformed data
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

function writeScanState(content: string): void {
  fs.writeFileSync(join(testDir, 'scan-state.json'), content);
}

function readActivityIndex(): string[] {
  const path = join(testDir, 'activity-index.jsonl');
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean);
}

function writeActivityIndex(lines: string[]): void {
  fs.writeFileSync(join(testDir, 'activity-index.jsonl'), lines.join('\n') + '\n');
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
  it('returns default state when file does not exist', () => {
    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns parsed state when file exists', () => {
    const expected: ScanState = {
      version: 1,
      files: {
        '/path/to/session.jsonl': { mtime: 1234567890, size: 1024, offset: 512 },
      },
    };
    writeScanState(JSON.stringify(expected));

    const state = loadScanState();
    expect(state).toEqual(expected);
  });

  it('returns default state on malformed JSON', () => {
    writeScanState('{ not valid json');

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns default state when version is wrong', () => {
    writeScanState(JSON.stringify({ version: 2, files: {} }));

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns default state when files field is missing', () => {
    writeScanState(JSON.stringify({ version: 1 }));

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns default state when files field is null', () => {
    writeScanState(JSON.stringify({ version: 1, files: null }));

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns default state when root is not an object', () => {
    writeScanState('"just a string"');

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });

  it('returns default state when root is null', () => {
    writeScanState('null');

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });
  });
});

// ============================================================================
// saveScanState
// ============================================================================

describe('saveScanState', () => {
  it('writes valid JSON readable by loadScanState', () => {
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

  it('cleans up .tmp file after successful write', () => {
    saveScanState({ version: 1, files: {} });

    const tmpPath = join(testDir, 'scan-state.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
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
  it('creates file if it does not exist', () => {
    const entry: ActivityIndexEntry = {
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: '/path/session.jsonl',
      preview: 'Hello world',
      offset: 0,
    };

    appendActivityEntries([entry]);

    const lines = readActivityIndex();
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it('appends to existing file without overwriting', () => {
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

    const lines = readActivityIndex();
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });

  it('writes multiple entries in one call', () => {
    const entries: ActivityIndexEntry[] = [
      { timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 },
      { timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 },
      { timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 },
    ];

    appendActivityEntries(entries);

    const lines = readActivityIndex();
    expect(lines.length).toBe(3);
  });

  it('is a no-op when entries array is empty', () => {
    appendActivityEntries([]);

    const indexPath = join(testDir, 'activity-index.jsonl');
    expect(fs.existsSync(indexPath)).toBe(false);
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

    const lines = readActivityIndex();
    const parsed = JSON.parse(lines[0]);
    expect(parsed.uuid).toBe('msg-abc-123');
  });
});

// ============================================================================
// queryActivity
// ============================================================================

describe('queryActivity', () => {
  it('returns empty array when file does not exist', () => {
    const result = queryActivity();
    expect(result).toEqual([]);
  });

  it('returns all entries sorted by timestamp ascending', () => {
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 }),
    ];
    writeActivityIndex(entries);

    const result = queryActivity();
    expect(result.length).toBe(3);
    expect(result[0].preview).toBe('A');
    expect(result[1].preview).toBe('B');
    expect(result[2].preview).toBe('C');
  });

  it('filters by from timestamp', () => {
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 }),
    ];
    writeActivityIndex(entries);

    const result = queryActivity({ from: '2025-01-15T11:00:00Z' });
    expect(result.length).toBe(2);
    expect(result[0].preview).toBe('B');
    expect(result[1].preview).toBe('C');
  });

  it('filters by to timestamp', () => {
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 }),
    ];
    writeActivityIndex(entries);

    const result = queryActivity({ to: '2025-01-15T11:00:00Z' });
    expect(result.length).toBe(2);
    expect(result[0].preview).toBe('A');
    expect(result[1].preview).toBe('B');
  });

  it('filters by both from and to timestamps', () => {
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 }),
    ];
    writeActivityIndex(entries);

    const result = queryActivity({ from: '2025-01-15T10:30:00Z', to: '2025-01-15T11:30:00Z' });
    expect(result.length).toBe(1);
    expect(result[0].preview).toBe('B');
  });

  it('skips malformed lines gracefully', () => {
    const lines = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 }),
      '{ not valid json',
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'C', offset: 0 }),
    ];
    writeActivityIndex(lines);

    const result = queryActivity();
    expect(result.length).toBe(2);
  });

  it('skips entries with missing required fields', () => {
    const lines = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'Valid', offset: 0 }),
      JSON.stringify({ kind: 'prompt', file: '/b.jsonl', preview: 'Missing timestamp', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', preview: 'Missing file', offset: 0 }),
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', offset: 0 }),
    ];
    writeActivityIndex(lines);

    const result = queryActivity();
    expect(result.length).toBe(1);
    expect(result[0].preview).toBe('Valid');
  });

  it('handles empty lines in file', () => {
    fs.writeFileSync(
      join(testDir, 'activity-index.jsonl'),
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0 }) + '\n' +
      '\n' +
      '   \n' +
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'B', offset: 0 }) + '\n'
    );

    const result = queryActivity();
    expect(result.length).toBe(2);
  });

  it('preserves uuid in returned entries', () => {
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'A', offset: 0, uuid: 'abc-123' }),
    ];
    writeActivityIndex(entries);

    const result = queryActivity();
    expect(result[0].uuid).toBe('abc-123');
  });
});
