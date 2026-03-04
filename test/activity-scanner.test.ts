/**
 * Tests for Activity Scanner
 *
 * Tests the scan orchestrator:
 * - Incremental scanning (skip unchanged files)
 * - Truncation detection (reset offset when file shrinks)
 * - Error isolation (one file failure doesn't abort batch)
 * - Graceful handling of vendors without scanUserActivity
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import type { SessionInfo, VendorDiscovery, UserActivityScanResult } from '../src/core/agent-adapter.js';
import type { Vendor } from '../src/core/transcript.js';
import { _setTestDir, loadScanState, saveScanState, queryActivity } from '../src/core/activity-index.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock session-manager
vi.mock('../src/core/session-manager.js', () => ({
  listAllSessions: vi.fn(),
  getDiscovery: vi.fn(),
}));

import { listAllSessions, getDiscovery } from '../src/core/session-manager.js';
import { runScan } from '../src/core/activity-scanner.js';

const mockListAllSessions = vi.mocked(listAllSessions);
const mockGetDiscovery = vi.mocked(getDiscovery);

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;
let cleanup: () => void;
let sessionFilesDir: string;

beforeEach(() => {
  // Create isolated temp directories for each test
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-test-'));
  sessionFilesDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-sessions-'));
  cleanup = _setTestDir(testDir);

  // Reset mocks
  mockListAllSessions.mockReset();
  mockGetDiscovery.mockReset();
});

afterEach(() => {
  cleanup();
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(sessionFilesDir, { recursive: true, force: true });
});

// ============================================================================
// Helper Functions
// ============================================================================

function createSessionFile(name: string, content: string): string {
  const path = join(sessionFilesDir, name);
  fs.writeFileSync(path, content);
  return path;
}

function createMockSession(path: string, vendor: Vendor = 'claude'): SessionInfo {
  const stat = fs.statSync(path);
  return {
    sessionId: `session-${path.split('/').pop()}`,
    path,
    projectSlug: 'test-project',
    modifiedAt: stat.mtime,
    size: stat.size,
    vendor,
  };
}

function createMockDiscovery(
  vendor: Vendor,
  scanResult?: UserActivityScanResult | ((path: string, offset?: number) => UserActivityScanResult),
): VendorDiscovery {
  return {
    vendor,
    findSession: vi.fn(),
    listSessions: vi.fn(() => []),
    loadHistory: vi.fn(async () => []),
    scanUserActivity: scanResult
      ? vi.fn((path: string, offset?: number) =>
          typeof scanResult === 'function' ? scanResult(path, offset) : scanResult)
      : undefined,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('runScan', () => {
  it('creates empty scan state with no registered adapters', () => {
    mockListAllSessions.mockReturnValue([]);

    runScan();

    const state = loadScanState();
    expect(state).toEqual({ version: 1, files: {} });

    const entries = queryActivity();
    expect(entries).toEqual([]);
  });

  it('scans sessions and produces ActivityIndexEntry objects', () => {
    const path = createSessionFile('a.jsonl', 'test content');
    const session = createMockSession(path);
    mockListAllSessions.mockReturnValue([session]);

    const discovery = createMockDiscovery('claude', {
      prompts: [
        { timestamp: '2025-01-15T10:00:00Z', preview: 'Hello world', offset: 0, uuid: 'msg-1' },
        { timestamp: '2025-01-15T11:00:00Z', preview: 'Second prompt', offset: 100, uuid: 'msg-2' },
      ],
      offset: 200,
    });
    mockGetDiscovery.mockReturnValue(discovery);

    runScan();

    const entries = queryActivity();
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({
      timestamp: '2025-01-15T10:00:00Z',
      kind: 'prompt',
      file: path,
      preview: 'Hello world',
      offset: 0,
      uuid: 'msg-1',
    });
    expect(entries[1]).toEqual({
      timestamp: '2025-01-15T11:00:00Z',
      kind: 'prompt',
      file: path,
      preview: 'Second prompt',
      offset: 100,
      uuid: 'msg-2',
    });
  });

  it('skips unchanged files on second scan', () => {
    const path = createSessionFile('a.jsonl', 'test content');
    const session = createMockSession(path);
    mockListAllSessions.mockReturnValue([session]);

    const discovery = createMockDiscovery('claude', {
      prompts: [{ timestamp: '2025-01-15T10:00:00Z', preview: 'First', offset: 0 }],
      offset: 100,
    });
    mockGetDiscovery.mockReturnValue(discovery);

    // First scan
    runScan();
    expect(discovery.scanUserActivity).toHaveBeenCalledTimes(1);

    // Second scan — file unchanged
    runScan();
    expect(discovery.scanUserActivity).toHaveBeenCalledTimes(1); // Still 1

    const entries = queryActivity();
    expect(entries.length).toBe(1); // No duplicates
  });

  it('rescans from saved offset when file grows', () => {
    const path = createSessionFile('a.jsonl', 'initial');
    const session = createMockSession(path);
    mockListAllSessions.mockReturnValue([session]);

    const discovery = createMockDiscovery('claude', (path, offset) => ({
      prompts: offset === 0
        ? [{ timestamp: '2025-01-15T10:00:00Z', preview: 'First', offset: 0 }]
        : [{ timestamp: '2025-01-15T11:00:00Z', preview: 'Second', offset: 100 }],
      offset: offset === 0 ? 100 : 200,
    }));
    mockGetDiscovery.mockReturnValue(discovery);

    // First scan
    runScan();
    expect(discovery.scanUserActivity).toHaveBeenCalledWith(path, 0);

    // Grow the file
    fs.appendFileSync(path, '\nmore content');

    // Update session mock with new stats
    mockListAllSessions.mockReturnValue([createMockSession(path)]);

    // Second scan — should scan from offset 100
    runScan();
    expect(discovery.scanUserActivity).toHaveBeenCalledWith(path, 100);

    const entries = queryActivity();
    expect(entries.length).toBe(2);
  });

  it('resets offset when file is truncated (size < cached)', () => {
    const filePath = createSessionFile('a.jsonl', 'a long initial content');
    const session = createMockSession(filePath);
    mockListAllSessions.mockReturnValue([session]);

    const discovery = createMockDiscovery('claude', {
      prompts: [{ timestamp: '2025-01-15T10:00:00Z', preview: 'Entry', offset: 0 }],
      offset: 500,
    });
    mockGetDiscovery.mockReturnValue(discovery);

    // First scan
    runScan();

    // Truncate the file (smaller than before)
    fs.writeFileSync(filePath, 'short');
    mockListAllSessions.mockReturnValue([createMockSession(filePath)]);

    // Second scan — should reset offset to 0
    runScan();
    expect(discovery.scanUserActivity).toHaveBeenLastCalledWith(filePath, 0);
  });

  it('gracefully skips vendors without scanUserActivity', () => {
    const path = createSessionFile('a.jsonl', 'test content');
    const session = createMockSession(path);
    mockListAllSessions.mockReturnValue([session]);

    // Discovery without scanUserActivity
    const discovery = createMockDiscovery('claude', undefined);
    mockGetDiscovery.mockReturnValue(discovery);

    // Should not throw
    runScan();

    // State should still be recorded (to skip on next scan)
    const state = loadScanState();
    expect(state.files[path]).toBeDefined();
    expect(state.files[path].offset).toBe(0);
  });

  it('skips sessions with empty path', () => {
    const session: SessionInfo = {
      sessionId: 'no-path-session',
      path: '',
      projectSlug: 'test',
      modifiedAt: new Date(),
      size: 0,
      vendor: 'claude',
    };
    mockListAllSessions.mockReturnValue([session]);

    const discovery = createMockDiscovery('claude', {
      prompts: [],
      offset: 0,
    });
    mockGetDiscovery.mockReturnValue(discovery);

    runScan();

    expect(discovery.scanUserActivity).not.toHaveBeenCalled();
  });

  it('isolates per-file errors without aborting batch', () => {
    const pathGood = createSessionFile('good.jsonl', 'good content');
    const pathBad = createSessionFile('bad.jsonl', 'bad content');

    const sessionGood = createMockSession(pathGood);
    const sessionBad = createMockSession(pathBad);
    mockListAllSessions.mockReturnValue([sessionGood, sessionBad]);

    // Delete bad file to cause stat error
    fs.unlinkSync(pathBad);

    const discovery = createMockDiscovery('claude', {
      prompts: [{ timestamp: '2025-01-15T10:00:00Z', preview: 'Good entry', offset: 0 }],
      offset: 100,
    });
    mockGetDiscovery.mockReturnValue(discovery);

    // Spy on console.error
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    runScan();

    // Good file was still scanned
    const entries = queryActivity();
    expect(entries.length).toBe(1);
    expect(entries[0].file).toBe(pathGood);

    // Error was logged for bad file
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[activity-scanner]'),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it('handles file deleted between listAllSessions and stat', () => {
    const path = createSessionFile('ephemeral.jsonl', 'content');
    const session = createMockSession(path);

    // File exists when listAllSessions is called
    mockListAllSessions.mockReturnValue([session]);

    // Delete file before stat
    fs.unlinkSync(path);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    runScan();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('handles multiple vendors correctly', () => {
    const pathClaude = createSessionFile('claude.jsonl', 'claude content');
    const pathCodex = createSessionFile('codex.jsonl', 'codex content');

    const sessionClaude = createMockSession(pathClaude, 'claude');
    const sessionCodex = createMockSession(pathCodex, 'codex');
    mockListAllSessions.mockReturnValue([sessionClaude, sessionCodex]);

    const claudeDiscovery = createMockDiscovery('claude', {
      prompts: [{ timestamp: '2025-01-15T10:00:00Z', preview: 'Claude prompt', offset: 0 }],
      offset: 100,
    });
    const codexDiscovery = createMockDiscovery('codex', {
      prompts: [{ timestamp: '2025-01-15T11:00:00Z', preview: 'Codex prompt', offset: 0 }],
      offset: 100,
    });

    mockGetDiscovery.mockImplementation((vendor) => {
      if (vendor === 'claude') return claudeDiscovery;
      if (vendor === 'codex') return codexDiscovery;
      return undefined;
    });

    runScan();

    const entries = queryActivity();
    expect(entries.length).toBe(2);
    expect(entries.find(e => e.preview === 'Claude prompt')).toBeDefined();
    expect(entries.find(e => e.preview === 'Codex prompt')).toBeDefined();
  });

  it('handles unknown vendor gracefully', () => {
    const path = createSessionFile('unknown.jsonl', 'content');
    const session = createMockSession(path, 'claude');
    mockListAllSessions.mockReturnValue([session]);

    // getDiscovery returns undefined for unknown vendor
    mockGetDiscovery.mockReturnValue(undefined);

    // Should not throw
    runScan();

    // State should still be recorded
    const state = loadScanState();
    expect(state.files[path]).toBeDefined();
  });

  it('does not save state if nothing changed', () => {
    mockListAllSessions.mockReturnValue([]);

    // Seed scan state via the public API (backed by SQLite now)
    const initialState = { version: 1 as const, files: { '/existing.jsonl': { mtime: 1, size: 1, offset: 1 } } };
    saveScanState(initialState);

    runScan();

    // State file should not have been modified (state still matches initial)
    const state = loadScanState();
    expect(state.files).toEqual(initialState.files);
  });
});
