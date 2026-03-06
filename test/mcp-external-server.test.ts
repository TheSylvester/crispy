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
      return { type: 'sdk', name: config.name ?? 'crispy' };
    },
    tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => ({
      name,
      handler,
    }),
    __getTools: () => tools,
  };
});

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

  it('dispatches child with stdio MCP tools and 120s timeout', async () => {
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

    // Core assertions: child gets MCP tools and sufficient timeout
    expect(callArgs.parentSessionId).toBe('session-abc');
    expect(callArgs.vendor).toBe('claude');
    expect(callArgs.settings.model).toBe('haiku');
    expect(callArgs.settings.permissionMode).toBe('bypassPermissions');
    expect(callArgs.settings.allowDangerouslySkipPermissions).toBe(true);
    expect(callArgs.forceNew).toBe(true);
    expect(callArgs.skipPersistSession).toBe(true);
    expect(callArgs.autoClose).toBe(true);
    expect(callArgs.timeoutMs).toBe(120_000);

    // MCP servers attached — child can call search tools
    expect(callArgs.mcpServers).toBeDefined();
    expect(callArgs.mcpServers['crispy-memory']).toBeDefined();
    expect(callArgs.mcpServers['crispy-memory'].type).toBe('stdio');

    // Env: bypass nested guard + extended MCP timeout
    expect(callArgs.env.CLAUDECODE).toBe('');
    expect(callArgs.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('120000');

    // Prompt tells child to use MCP tools (not pre-fetched data)
    const promptText = callArgs.prompt[0].text;
    expect(promptText).toContain('authentication');
    expect(promptText).toContain('search_sessions');
    expect(promptText).toContain('session_context');

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
});
