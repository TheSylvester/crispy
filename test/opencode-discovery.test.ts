/**
 * Tests for opencode-discovery.ts — Tier 2
 *
 * Mocks child_process.execFile to return pre-built JSON matching `sqlite3 -json` output.
 * Uses vi.mock hoisting to ensure mocks are in place before the discovery module loads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process — vi.mock is hoisted above imports
const mockExecFile = vi.fn();

// execFile has [Symbol.for('nodejs.util.promisify.custom')] which changes how
// promisify works. We need to set it on our mock so promisify(mockExecFile)
// returns a function that calls our mock with the right shape.
const customPromisify = Symbol.for('nodejs.util.promisify.custom');
(mockExecFile as any)[customPromisify] = vi.fn();
const mockExecFilePromisified = (mockExecFile as any)[customPromisify] as ReturnType<typeof vi.fn>;

vi.mock('node:child_process', () => {
  return {
    execFile: mockExecFile,
    execFileSync: vi.fn(() => '[]'),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('opencode.db')) return true;
      return orig.existsSync(path);
    }),
  };
});

// Dynamic import after mocking — the discovery module loads with the mocked child_process
const { opencodeDiscovery } = await import('../src/core/adapters/opencode/opencode-discovery.js');

/**
 * Set up the promisified execFile mock to return a specific result.
 *
 * Because Node's execFile has `[Symbol.for('nodejs.util.promisify.custom')]`,
 * promisify(execFile) uses that custom function, not the callback wrapper.
 * We mock that custom function.
 */
function setupQueryResult(result: string) {
  mockExecFilePromisified.mockResolvedValue({ stdout: result, stderr: '' });
}

function setupQueryError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  mockExecFilePromisified.mockRejectedValue(err);
}

describe('OpenCodeDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listSessions', () => {
    it('returns empty list when DB has no sessions', async () => {
      setupQueryResult('[]');
      await opencodeDiscovery.refresh();
      const sessions = opencodeDiscovery.listSessions();
      expect(sessions).toEqual([]);
    });

    it('maps session rows to SessionInfo correctly', async () => {
      const sessionRows = JSON.stringify([{
        id: 'sess-1',
        project_id: 'proj-1',
        directory: '/home/user/project',
        title: 'Fix bug',
        parent_id: null,
        summary_additions: 10,
        summary_deletions: 5,
        summary_files: 3,
        time_created: '2026-03-01T00:00:00Z',
        time_updated: '2026-03-06T12:00:00Z',
      }]);

      setupQueryResult(sessionRows);
      await opencodeDiscovery.refresh();
      const sessions = opencodeDiscovery.listSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('sess-1');
      expect(sessions[0].projectPath).toBe('/home/user/project');
      expect(sessions[0].label).toBe('Fix bug');
      expect(sessions[0].vendor).toBe('opencode');
      expect(sessions[0].size).toBe(15);
      expect(sessions[0].isSidechain).toBe(false);
    });

    it('marks sessions with parent_id as sidechain', async () => {
      const sessionRows = JSON.stringify([{
        id: 'child-1',
        project_id: 'proj-1',
        directory: '/home/user/project',
        title: 'Subtask',
        parent_id: 'parent-1',
        summary_additions: 0,
        summary_deletions: 0,
        summary_files: 0,
        time_created: '2026-03-01T00:00:00Z',
        time_updated: '2026-03-06T12:00:00Z',
      }]);

      setupQueryResult(sessionRows);
      await opencodeDiscovery.refresh();
      const sessions = opencodeDiscovery.listSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].isSidechain).toBe(true);
    });
  });

  describe('findSession', () => {
    it('returns matching session', async () => {
      const sessionRows = JSON.stringify([{
        id: 'target-sess',
        project_id: 'proj-1',
        directory: '/home/user/project',
        title: 'Target',
        parent_id: null,
        summary_additions: 0,
        summary_deletions: 0,
        summary_files: 0,
        time_created: '2026-03-01T00:00:00Z',
        time_updated: '2026-03-06T12:00:00Z',
      }]);

      setupQueryResult(sessionRows);
      await opencodeDiscovery.refresh();

      expect(opencodeDiscovery.findSession('target-sess')?.sessionId).toBe('target-sess');
      expect(opencodeDiscovery.findSession('nonexistent')).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('returns empty on sqlite3 not found (ENOENT)', async () => {
      setupQueryError('ENOENT');
      await opencodeDiscovery.refresh();
      expect(opencodeDiscovery.listSessions()).toEqual([]);
    });

    it('returns empty on generic error', async () => {
      setupQueryError('EPERM');
      await opencodeDiscovery.refresh();
      expect(opencodeDiscovery.listSessions()).toEqual([]);
    });
  });
});
