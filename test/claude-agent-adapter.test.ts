/**
 * Tests for ClaudeAgentAdapter
 *
 * The adapter is a thin delegation wrapper — Channel behavior is already
 * tested exhaustively in claude-code-adapter.test.ts. These tests focus
 * on the adapter's own responsibilities: construction defaults and the
 * history/discovery composition logic (the only non-trivial code).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ---------------------------------------------------------------------------
// Mock: @anthropic-ai/claude-agent-sdk (needed because ClaudeCodeChannel
// imports it at module level)
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: free history/discovery functions from claude-code-adapter
// ---------------------------------------------------------------------------

const mockFindSession = vi.fn();
const mockListSessions = vi.fn();
const mockLoadHistory = vi.fn();

vi.mock('../src/core/adapters/claude/claude-code-adapter.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    findSession: (...args: unknown[]) => mockFindSession(...args),
    listSessions: (...args: unknown[]) => mockListSessions(...args),
    loadHistory: (...args: unknown[]) => mockLoadHistory(...args),
  };
});

// Import AFTER mocks are registered
import { ClaudeAgentAdapter } from '../src/core/adapters/claude/claude-agent-adapter.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFindSession.mockReset();
  mockListSessions.mockReset();
  mockLoadHistory.mockReset();
});

// ========== Construction ==========

describe('Construction', () => {
  it('has vendor "claude" and correct defaults', () => {
    const adapter = new ClaudeAgentAdapter({ cwd: '/tmp' });
    expect(adapter.vendor).toBe('claude');
    expect(adapter.status).toBe('idle');
    expect(adapter.sessionId).toBeUndefined();
    expect(adapter.metadata).toBeNull();
    expect(adapter.contextUsage).toBeNull();
  });
});

// ========== History delegation (adapter-specific composition logic) ==========

describe('History delegation', () => {
  it('loadHistory() resolves ID → path via findSession then loads', async () => {
    const mockEntries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    ];

    mockFindSession.mockReturnValue({
      sessionId: 'abc-123',
      path: '/home/user/.claude/projects/proj/abc-123.jsonl',
      projectSlug: 'proj',
      modifiedAt: new Date(),
      size: 1024,
      vendor: 'claude',
    });
    mockLoadHistory.mockResolvedValue(mockEntries);

    const adapter = new ClaudeAgentAdapter({ cwd: '/tmp' });
    const result = await adapter.loadHistory('abc-123');

    expect(mockFindSession).toHaveBeenCalledWith('abc-123');
    expect(mockLoadHistory).toHaveBeenCalledWith('/home/user/.claude/projects/proj/abc-123.jsonl');
    expect(result).toEqual(mockEntries);
  });

  it('loadHistory() returns empty array when session not found', async () => {
    mockFindSession.mockReturnValue(undefined);

    const adapter = new ClaudeAgentAdapter({ cwd: '/tmp' });
    const result = await adapter.loadHistory('nonexistent');

    expect(mockFindSession).toHaveBeenCalledWith('nonexistent');
    expect(mockLoadHistory).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('findSession() delegates to free function', () => {
    const sessionInfo = {
      sessionId: 'xyz',
      path: '/path/to/xyz.jsonl',
      projectSlug: 'proj',
      modifiedAt: new Date(),
      size: 512,
      vendor: 'claude' as const,
    };
    mockFindSession.mockReturnValue(sessionInfo);

    const adapter = new ClaudeAgentAdapter({ cwd: '/tmp' });
    expect(adapter.findSession('xyz')).toEqual(sessionInfo);
    expect(mockFindSession).toHaveBeenCalledWith('xyz');
  });

  it('listSessions() delegates to free function', () => {
    const sessions = [
      { sessionId: 'a', path: '/a.jsonl', projectSlug: 'p', modifiedAt: new Date(), size: 100, vendor: 'claude' as const },
      { sessionId: 'b', path: '/b.jsonl', projectSlug: 'p', modifiedAt: new Date(), size: 200, vendor: 'claude' as const },
    ];
    mockListSessions.mockReturnValue(sessions);

    const adapter = new ClaudeAgentAdapter({ cwd: '/tmp' });
    expect(adapter.listSessions()).toEqual(sessions);
    expect(mockListSessions).toHaveBeenCalledWith();
  });
});
