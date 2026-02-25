/**
 * Tests for Codex entry adapter (ThreadItem -> TranscriptEntry)
 *
 * Validates that adaptCodexItem correctly transforms Codex protocol
 * ThreadItem types into universal TranscriptEntry format.
 */

import { describe, it, expect } from 'vitest';
import { adaptCodexItem, adaptCodexDelta } from '../src/core/adapters/codex/codex-entry-adapter.js';
import type { ContentBlock, ToolUseBlock, ThinkingBlock } from '../src/core/transcript.js';
import type { ThreadItem } from '../src/core/adapters/codex/protocol/v2/ThreadItem.js';

describe('adaptCodexItem', () => {
  const threadId = 'test-thread-123';
  const turnId = '0';

  // ========== Group 1: User Messages ==========

  describe('userMessage', () => {
    it('adapts userMessage to user entry', () => {
      const item: ThreadItem = {
        type: 'userMessage',
        id: 'msg-1',
        content: [{ type: 'text', text: 'Hello world', text_elements: [] }],
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('user');
      expect(entries[0].vendor).toBe('codex');
      expect(entries[0].uuid).toBe('msg-1');
      expect(entries[0].sessionId).toBe(threadId);
      expect(entries[0].message?.role).toBe('user');
      // Content is array of ContentBlocks
      const content = entries[0].message?.content as ContentBlock[];
      expect(content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello world' }));
    });

    it('handles userMessage with image content', () => {
      const item: ThreadItem = {
        type: 'userMessage',
        id: 'msg-2',
        content: [
          { type: 'text', text: 'Check this:', text_elements: [] },
          { type: 'image', url: 'https://example.com/img.png' },
        ],
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      const content = entries[0].message?.content;
      expect(Array.isArray(content)).toBe(true);
      expect((content as ContentBlock[])).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Check this:' })
      );
    });

    it('handles userMessage with localImage', () => {
      const item: ThreadItem = {
        type: 'userMessage',
        id: 'msg-3',
        content: [
          { type: 'localImage', path: '/home/user/screenshot.png' },
        ],
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('user');
    });
  });

  // ========== Group 2: Agent Messages ==========

  describe('agentMessage', () => {
    it('adapts agentMessage to assistant entry', () => {
      const item: ThreadItem = {
        type: 'agentMessage',
        id: 'msg-4',
        text: 'Hello from Codex.',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
      expect(entries[0].vendor).toBe('codex');
      expect(entries[0].uuid).toBe('msg-4');
      expect(entries[0].message?.role).toBe('assistant');
      expect(entries[0].message?.content).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Hello from Codex.' })
      );
    });

    it('adapts empty agentMessage', () => {
      const item: ThreadItem = {
        type: 'agentMessage',
        id: 'msg-5',
        text: '',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
    });
  });

  // ========== Group 3: Reasoning ==========

  describe('reasoning', () => {
    it('adapts reasoning to thinking block', () => {
      const item: ThreadItem = {
        type: 'reasoning',
        id: 'rs-1',
        summary: ['**Responding with greeting**'],
        content: [],
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
      expect(entries[0].uuid).toBe('rs-1');

      const content = entries[0].message?.content as ContentBlock[];
      const thinkingBlock = content.find(b => b.type === 'thinking') as ThinkingBlock;

      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock.thinking).toContain('Responding with greeting');
      // isSummary is in metadata for summary entries
      expect(thinkingBlock.metadata?.isSummary).toBe(true);
    });

    it('handles reasoning with raw content', () => {
      const item: ThreadItem = {
        type: 'reasoning',
        id: 'rs-2',
        summary: [],
        content: ['Full reasoning text here'],
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      const content = entries[0].message?.content as ContentBlock[];
      const thinkingBlock = content.find(b => b.type === 'thinking') as ThinkingBlock;

      expect(thinkingBlock.thinking).toContain('Full reasoning text');
    });

    it('includes both summary and raw content when present', () => {
      const item: ThreadItem = {
        type: 'reasoning',
        id: 'rs-3',
        summary: ['Summary text'],
        content: ['Raw content'],
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      const content = entries[0].message?.content as ContentBlock[];
      const thinkingBlocks = content.filter(b => b.type === 'thinking') as ThinkingBlock[];

      // Should have both summary and raw content blocks
      expect(thinkingBlocks.length).toBeGreaterThanOrEqual(1);
      // First block (from summary) should have isSummary marker
      expect(thinkingBlocks[0].metadata?.isSummary).toBe(true);
      expect(thinkingBlocks[0].thinking).toBe('Summary text');
    });
  });

  // ========== Group 4: Command Execution ==========

  describe('commandExecution', () => {
    it('adapts commandExecution to tool use and result', () => {
      const item: ThreadItem = {
        type: 'commandExecution',
        id: 'call-1',
        command: 'ls -la',
        cwd: '/home/user',
        processId: null,
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'file1\nfile2',
        exitCode: 0,
        durationMs: 150,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      // Should produce 2 entries: tool_use (assistant) + tool_result
      expect(entries).toHaveLength(2);

      // First entry: assistant with tool_use block
      expect(entries[0].type).toBe('assistant');
      const toolUse = (entries[0].message?.content as ContentBlock[])
        .find(b => b.type === 'tool_use') as ToolUseBlock;
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe('Bash');
      expect(toolUse.input).toMatchObject({ command: 'ls -la' });

      // Second entry: tool_result
      expect(entries[1].type).toBe('result');
      expect(entries[1].toolUseResult).toBeDefined();
      expect(entries[1].toolUseResult).toMatchObject({
        output: 'file1\nfile2',
        exitCode: 0,
      });
    });

    it('marks failed command as error', () => {
      const item: ThreadItem = {
        type: 'commandExecution',
        id: 'call-2',
        command: 'false',
        cwd: '/tmp',
        processId: null,
        status: 'failed',
        commandActions: [],
        aggregatedOutput: 'command not found',
        exitCode: 1,
        durationMs: 10,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(2);
      const result = entries[1].toolUseResult;
      expect(result).toMatchObject({
        exitCode: 1,
      });
      // Tool result block should indicate error
      const content = entries[1].message?.content as ContentBlock[];
      const toolResultBlock = content.find(b => b.type === 'tool_result');
      expect(toolResultBlock).toBeDefined();
      // is_error is on the block itself
      expect((toolResultBlock as any).is_error).toBe(true);
    });

    it('handles in-progress command', () => {
      const item: ThreadItem = {
        type: 'commandExecution',
        id: 'call-3',
        command: 'sleep 10',
        cwd: '/tmp',
        processId: 'pty-123',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      // Still produces entries, but result is pending
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].metadata?.status).toBe('inProgress');
    });

    it('handles declined command', () => {
      const item: ThreadItem = {
        type: 'commandExecution',
        id: 'call-4',
        command: 'rm -rf /',
        cwd: '/',
        processId: null,
        status: 'declined',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].metadata?.status).toBe('declined');
    });
  });

  // ========== Group 5: File Changes ==========

  describe('fileChange', () => {
    it('adapts fileChange to tool use and result', () => {
      const item: ThreadItem = {
        type: 'fileChange',
        id: 'fc-1',
        changes: [{
          path: '/home/user/test.txt',
          kind: { type: 'update', move_path: null },
          diff: '- old line\n+ new line',
        }],
        status: 'completed',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(2);

      // Tool use should be Edit or Write
      const toolUse = (entries[0].message?.content as ContentBlock[])
        .find(b => b.type === 'tool_use') as ToolUseBlock;
      expect(['Edit', 'Write']).toContain(toolUse.name);
    });

    it('handles multiple file changes', () => {
      const item: ThreadItem = {
        type: 'fileChange',
        id: 'fc-2',
        changes: [
          { path: '/a.txt', kind: { type: 'add' }, diff: '+ line' },
          { path: '/b.txt', kind: { type: 'update', move_path: null }, diff: '- old\n+ new' },
        ],
        status: 'completed',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      // Should produce 2 entries (tool use + result)
      expect(entries).toHaveLength(2);
    });

    it('uses Write tool for all-add changes', () => {
      const item: ThreadItem = {
        type: 'fileChange',
        id: 'fc-3',
        changes: [
          { path: '/new-file.txt', kind: { type: 'add' }, diff: '+ new content' },
        ],
        status: 'completed',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      const toolUse = (entries[0].message?.content as ContentBlock[])
        .find(b => b.type === 'tool_use') as ToolUseBlock;
      expect(toolUse.name).toBe('Write');
    });
  });

  // ========== Group 6: MCP Tool Calls ==========

  describe('mcpToolCall', () => {
    it('adapts mcpToolCall to tool use and result', () => {
      const item: ThreadItem = {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'my-server',
        tool: 'some-tool',
        status: 'completed',
        arguments: { arg1: 'value' },
        result: { content: [{ type: 'text', text: 'tool output' }], structuredContent: null },
        error: null,
        durationMs: 200,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(2);

      const toolUse = (entries[0].message?.content as ContentBlock[])
        .find(b => b.type === 'tool_use') as ToolUseBlock;
      expect(toolUse.name).toContain('mcp__');
    });

    it('handles mcpToolCall error', () => {
      const item: ThreadItem = {
        type: 'mcpToolCall',
        id: 'mcp-2',
        server: 'my-server',
        tool: 'failing-tool',
        status: 'failed',
        arguments: {},
        result: null,
        error: { message: 'Tool failed' },
        durationMs: 50,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
      // Result entry should have is_error on the tool_result block
      const resultEntry = entries.find(e => e.type === 'result');
      expect(resultEntry).toBeDefined();
      const toolResultBlock = (resultEntry?.message?.content as ContentBlock[])?.find(b => b.type === 'tool_result');
      expect((toolResultBlock as any)?.is_error).toBe(true);
    });
  });

  // ========== Group 7: Web Search ==========

  describe('webSearch', () => {
    it('adapts webSearch to tool use', () => {
      const item: ThreadItem = {
        type: 'webSearch',
        id: 'ws-1',
        query: 'typescript generics',
        action: { type: 'search', query: 'typescript generics', queries: null },
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].type).toBe('assistant');

      const toolUse = (entries[0].message?.content as ContentBlock[])
        .find(b => b.type === 'tool_use') as ToolUseBlock;
      expect(toolUse.name).toBe('WebSearch');
      expect(toolUse.input).toMatchObject({ query: 'typescript generics' });
    });

    it('handles webSearch with null action', () => {
      const item: ThreadItem = {
        type: 'webSearch',
        id: 'ws-2',
        query: 'pending search',
        action: null,
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ========== Group 8: Context Compaction ==========

  describe('contextCompaction', () => {
    it('adapts contextCompaction to system entry', () => {
      const item: ThreadItem = {
        type: 'contextCompaction',
        id: 'cc-1',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('system');
      expect(entries[0].uuid).toBe('cc-1');
    });
  });

  // ========== Group 9: Plan ==========

  describe('plan', () => {
    it('adapts plan with isPlan metadata', () => {
      const item: ThreadItem = {
        type: 'plan',
        id: 'plan-1',
        text: 'Step 1: Analyze requirements\nStep 2: Implement solution',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
      expect(entries[0].metadata?.isPlan).toBe(true);

      const content = entries[0].message?.content as ContentBlock[];
      expect(content).toContainEqual(
        expect.objectContaining({ type: 'text' })
      );
    });
  });

  // ========== Group 10: Special Items ==========

  describe('special items', () => {
    it('adapts imageView item', () => {
      const item: ThreadItem = {
        type: 'imageView',
        id: 'iv-1',
        path: '/home/user/diagram.png',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('adapts enteredReviewMode item', () => {
      const item: ThreadItem = {
        type: 'enteredReviewMode',
        id: 'review-1',
        review: 'PR review mode',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].type).toBe('system');
    });

    it('adapts exitedReviewMode item', () => {
      const item: ThreadItem = {
        type: 'exitedReviewMode',
        id: 'review-2',
        review: 'Review complete',
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('adapts collabAgentToolCall item', () => {
      const item: ThreadItem = {
        type: 'collabAgentToolCall',
        id: 'collab-1',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'parent-thread',
        receiverThreadIds: ['child-thread'],
        prompt: 'Do subtask',
        agentsStates: {},
      };

      const entries = adaptCodexItem(item, threadId, turnId);

      expect(entries.length).toBeGreaterThanOrEqual(1);
      // Uses isSidechain flag for sub-agent entries
      expect(entries[0].isSidechain).toBe(true);
    });
  });
});

// ============================================================================
// Delta Adapter Tests
// ============================================================================

describe('adaptCodexDelta', () => {
  it('adapts agentMessage delta', () => {
    const entry = adaptCodexDelta('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: '0',
      itemId: 'msg-1',
      delta: 'Hello',
    });

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('stream_event');
    expect(entry?.vendor).toBe('codex');
    expect(entry?.uuid).toBe('msg-1');
  });

  it('adapts reasoning summaryTextDelta', () => {
    const entry = adaptCodexDelta('item/reasoning/summaryTextDelta', {
      threadId: 'thread-1',
      turnId: '0',
      itemId: 'rs-1',
      delta: 'Thinking...',
      summaryIndex: 0,
    });

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('stream_event');
    expect(entry?.uuid).toBe('rs-1');
    // Should have thinking block with delta text
    const content = entry?.message?.content as ContentBlock[];
    const thinkingBlock = content?.find(b => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
  });

  it('returns null for unknown method', () => {
    const entry = adaptCodexDelta('unknown/method', {});
    expect(entry).toBeNull();
  });

  it('returns null for non-delta notifications', () => {
    const entry = adaptCodexDelta('turn/completed', { threadId: '1' });
    expect(entry).toBeNull();
  });

  it('preserves itemId in delta entries', () => {
    const entry = adaptCodexDelta('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: '0',
      itemId: 'specific-id',
      delta: 'text',
    });

    expect(entry?.uuid).toBe('specific-id');
    expect(entry?.sessionId).toBe('thread-1');
  });

  it('includes turnId in metadata', () => {
    const entry = adaptCodexDelta('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: '42',
      itemId: 'msg-1',
      delta: 'Hello',
    });

    expect(entry?.metadata?.turnId).toBe('42');
  });
});
