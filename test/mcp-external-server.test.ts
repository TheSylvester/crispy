/**
 * Tests for the external MCP server (servers/external.ts).
 *
 * Verifies the relay pattern: fetch data → build prompt → dispatch child → return.
 * Mocks AgentDispatch.dispatchChild and memory-queries to control both sides.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDispatch } from '../src/host/agent-dispatch.js';
import type { ChildSessionResult } from '../src/core/session-manager.js';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const tools: Map<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> = new Map();

  return {
    createSdkMcpServer: (config: { name?: string; tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> }) => {
      for (const t of config.tools) {
        tools.set(t.name, { handler: t.handler });
      }
      return { type: 'sdk', name: config.name ?? 'crispy' };
    },
    tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => ({
      name,
      handler,
    }),
    __getTools: () => tools,
  };
});

// Mock memory-queries — control what data the relay fetches
vi.mock('../src/mcp/memory-queries.js', () => ({
  getDbPath: () => '/tmp/test.db',
  searchSessions: vi.fn().mockReturnValue([
    {
      id: 1,
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'implement authentication',
      title: 'Auth System',
      match_snippet: '>>>authentication<<< system implementation',
      rank: -1.5,
    },
  ]),
  listSessions: vi.fn().mockReturnValue([]),
  sessionContext: vi.fn().mockReturnValue([
    {
      id: 1,
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'implement authentication',
      summary: 'Built JWT auth with refresh tokens',
      title: 'Auth System',
      status: 'completed',
      entities: '["JWT", "auth.ts"]',
    },
  ]),
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockDispatch(result: ChildSessionResult | null = null): AgentDispatch {
  return {
    listSessions: vi.fn(),
    findSession: vi.fn(),
    loadSession: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendTurn: vi.fn(),
    resolveApproval: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    dispatchChild: vi.fn().mockResolvedValue(result),
    onEvent: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  } as unknown as AgentDispatch;
}

async function getRecallTool() {
  const mod = await import('@anthropic-ai/claude-agent-sdk') as unknown as {
    __getTools: () => Map<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  };
  return mod.__getTools().get('recall')!;
}

// ============================================================================
// Tests
// ============================================================================

describe('external MCP server — recall tool (relay pattern)', () => {
  let createExternalServer: typeof import('../src/mcp/servers/external.js').createExternalServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/mcp/servers/external.js');
    createExternalServer = mod.createExternalServer;
  });

  it('creates a server with a recall tool', () => {
    const dispatch = createMockDispatch();
    const server = createExternalServer(dispatch);
    expect(server).toBeDefined();
  });

  it('dispatches child with pre-fetched data in prompt — no MCP servers', async () => {
    const mockResult: ChildSessionResult = {
      sessionId: 'child-123',
      text: 'You worked on JWT authentication in the Auth System session.',
    };
    const dispatch = createMockDispatch(mockResult);
    createExternalServer(dispatch, () => 'session-abc');

    const recallTool = await getRecallTool();
    const result = await recallTool.handler({ query: 'authentication' });

    // Verify dispatch was called
    expect(dispatch.dispatchChild).toHaveBeenCalledOnce();
    const callArgs = (dispatch.dispatchChild as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Core assertions: Rosie-style dispatch, NO MCP servers
    expect(callArgs.parentSessionId).toBe('session-abc');
    expect(callArgs.vendor).toBe('claude');
    expect(callArgs.settings.model).toBe('haiku');
    expect(callArgs.skipPersistSession).toBe(true);
    expect(callArgs.autoClose).toBe(true);
    expect(callArgs.mcpServers).toBeUndefined();  // ← the key change
    expect(callArgs.env).toBeUndefined();          // ← no CLAUDECODE hack

    // Prompt should contain the pre-fetched data
    const promptText = callArgs.prompt[0].text;
    expect(promptText).toContain('authentication');
    expect(promptText).toContain('Auth System');

    // Result passes through
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe('You worked on JWT authentication in the Auth System session.');
  });

  it('returns error message when no active session', async () => {
    const dispatch = createMockDispatch();
    createExternalServer(dispatch, () => undefined);

    const recallTool = await getRecallTool();
    const result = await recallTool.handler({ query: 'anything' });
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain('no active session');
  });

  it('returns timeout message when dispatch returns null', async () => {
    const dispatch = createMockDispatch(null);
    createExternalServer(dispatch, () => 'session-123');

    const recallTool = await getRecallTool();
    const result = await recallTool.handler({ query: 'anything' });
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain('timed out');
  });

  it('falls back to recent sessions when search returns nothing', async () => {
    // Override search to return empty, list to return recent
    const { searchSessions, listSessions } = await import('../src/mcp/memory-queries.js') as unknown as {
      searchSessions: ReturnType<typeof vi.fn>;
      listSessions: ReturnType<typeof vi.fn>;
    };
    searchSessions.mockReturnValueOnce([]);
    listSessions.mockReturnValueOnce([
      { file: '/sessions/recent.jsonl', last_activity: '2025-06-02', title: 'Recent Work', entry_count: 5 },
    ]);

    const mockResult: ChildSessionResult = { sessionId: 'child-456', text: 'Found recent sessions.' };
    const dispatch = createMockDispatch(mockResult);
    createExternalServer(dispatch, () => 'session-abc');

    const recallTool = await getRecallTool();
    await recallTool.handler({ query: 'xyzzy_nonexistent' });

    const callArgs = (dispatch.dispatchChild as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const promptText = callArgs.prompt[0].text;
    expect(promptText).toContain('Recent Work');
    expect(promptText).toContain('No direct search matches');
  });
});
