/**
 * Tests for the external MCP server (servers/external.ts).
 *
 * Verifies the relay pattern: dispatch child with stdio MCP tools attached,
 * child does its own searching and synthesis, relay returns the result.
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
      return { type: 'sdk', name: config.name ?? 'memory' };
    },
    tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => ({
      name,
      handler,
    }),
    __getTools: () => tools,
  };
});

// Mock session-manager (findSession used inside the recall handler)
vi.mock('../src/core/session-manager.js', () => ({
  findSession: vi.fn().mockReturnValue({ projectPath: '/mock/project' }),
}));

// Mock model-utils (parseModelOption used inside the recall handler)
vi.mock('../src/core/model-utils.js', () => ({
  parseModelOption: vi.fn().mockReturnValue({ vendor: 'claude', model: '' }),
}));

// Mock rosie logging (side-effect imports used inside the recall handler)
vi.mock('../src/core/rosie/index.js', () => ({
  pushRosieLog: vi.fn(),
}));
vi.mock('../src/core/rosie/event-log.js', () => ({
  pushEventLog: vi.fn(),
}));

// Mock core log (prevents test errors from polluting production crispy.db)
vi.mock('../src/core/log.js', () => ({
  log: vi.fn(),
  registerLogPersister: vi.fn(),
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

const stubServerPaths = {
  internalServerCommand: '/usr/bin/node',
  internalServerArgs: ['/fake/dist/internal-mcp.js'],
};

async function getRecallTool() {
  const mod = await import('@anthropic-ai/claude-agent-sdk') as unknown as {
    __getTools: () => Map<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  };
  return mod.__getTools().get('recall_conversations')!;
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
    const server = createExternalServer(dispatch, { sessionId: 'session-1', vendor: 'claude' }, stubServerPaths);
    expect(server).toBeDefined();
  });

  it('dispatches child with stdio MCP tools and 180s timeout', async () => {
    const mockResult: ChildSessionResult = {
      sessionId: 'child-123',
      text: 'You worked on JWT authentication in the Auth System session.',
    };
    const dispatch = createMockDispatch(mockResult);
    createExternalServer(dispatch, { sessionId: 'session-abc', vendor: 'claude' }, stubServerPaths);

    const recallTool = await getRecallTool();
    const result = await recallTool.handler({ query: 'authentication' });

    // Verify dispatch was called
    expect(dispatch.dispatchChild).toHaveBeenCalledOnce();
    const callArgs = (dispatch.dispatchChild as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Core assertions: child gets MCP tools and sufficient timeout
    expect(callArgs.parentSessionId).toBe('session-abc');
    expect(callArgs.vendor).toBe('claude');
    expect(callArgs.parentVendor).toBe('claude');
    expect(callArgs.settings.model).toBe('haiku');
    expect(callArgs.settings.permissionMode).toBe('bypassPermissions');
    expect(callArgs.settings.allowDangerouslySkipPermissions).toBe(true);
    expect(callArgs.forceNew).toBe(true);
    expect(callArgs.skipPersistSession).toBe(true);
    expect(callArgs.autoClose).toBe(true);
    expect(callArgs.timeoutMs).toBe(180_000);

    // MCP servers attached — child can call search tools
    expect(callArgs.mcpServers).toBeDefined();
    expect(callArgs.mcpServers['crispy-memory']).toBeDefined();
    expect(callArgs.mcpServers['crispy-memory'].type).toBe('stdio');

    // Env: bypass nested guard + extended MCP timeout
    expect(callArgs.env.CLAUDECODE).toBe('');
    expect(callArgs.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('180000');

    // Prompt tells child to use MCP tools (not pre-fetched data)
    const promptText = callArgs.prompt[0].text;
    expect(promptText).toContain('authentication');
    expect(promptText).toContain('search_transcript');
    expect(promptText).toContain('read_message');

    // Result passes through
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe('You worked on JWT authentication in the Auth System session.');
  });

  it('returns timeout message when dispatch returns null', async () => {
    const dispatch = createMockDispatch(null);
    createExternalServer(dispatch, { sessionId: 'session-123', vendor: 'claude' }, stubServerPaths);

    const recallTool = await getRecallTool();
    const result = await recallTool.handler({ query: 'anything' });
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain('timed out');
  });

  it('returns error message when dispatch throws', async () => {
    const dispatch = createMockDispatch();
    (dispatch.dispatchChild as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dispatch failed'));
    createExternalServer(dispatch, { sessionId: 'session-456', vendor: 'claude' }, stubServerPaths);

    const recallTool = await getRecallTool();
    const result = await recallTool.handler({ query: 'anything' });
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain('dispatch failed');
  });
});
