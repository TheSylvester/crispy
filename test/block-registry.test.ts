/**
 * Tests for resolveBlockType — three-level discrimination tree for content blocks
 *
 * Every key is now role-prefixed: resolveBlockType(block, role) → 'role:blockKey'
 */

import { describe, it, expect } from 'vitest';
import { resolveBlockType } from '../src/webview/renderers/block-registry.js';
import type { ContentBlock } from '../src/core/transcript.js';

describe('resolveBlockType', () => {
  // ── Level 1: block.type dispatch (with role prefix) ─────────────────

  it('resolves text blocks to "assistant:text"', () => {
    expect(resolveBlockType({ type: 'text', text: 'hello' }, 'assistant')).toBe('assistant:text');
  });

  it('resolves thinking blocks to "assistant:thinking"', () => {
    expect(resolveBlockType({ type: 'thinking', thinking: 'hmm' }, 'assistant')).toBe('assistant:thinking');
  });

  it('resolves image blocks to "assistant:image"', () => {
    expect(resolveBlockType({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    }, 'assistant')).toBe('assistant:image');
  });

  it('resolves tool_result to "tool:tool_result" (no longer null)', () => {
    expect(resolveBlockType({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'result',
    }, 'tool')).toBe('tool:tool_result');
  });

  // ── Role-specific behavior ──────────────────────────────────────────

  describe('role prefixing', () => {
    it('prefixes user role on text blocks', () => {
      expect(resolveBlockType({ type: 'text', text: 'hi' }, 'user')).toBe('user:text');
    });

    it('prefixes assistant role on text blocks', () => {
      expect(resolveBlockType({ type: 'text', text: 'hi' }, 'assistant')).toBe('assistant:text');
    });

    it('prefixes system role on text blocks', () => {
      expect(resolveBlockType({ type: 'text', text: 'summary' }, 'system')).toBe('system:text');
    });

    it('prefixes tool role on tool_result blocks', () => {
      expect(resolveBlockType({
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'output',
      }, 'tool')).toBe('tool:tool_result');
    });

    it('prefixes assistant role on tool_use blocks', () => {
      expect(resolveBlockType({
        type: 'tool_use', id: 'tu_bash', name: 'Bash', input: {},
      }, 'assistant')).toBe('assistant:tool:Bash');
    });
  });

  // ── Level 2: tool_use name dispatch ──────────────────────────────────

  describe('tool_use blocks', () => {
    function toolBlock(name: string): ContentBlock {
      return { type: 'tool_use', id: `tu_${name}`, name, input: {} };
    }

    it('resolves Bash → assistant:tool:Bash', () => {
      expect(resolveBlockType(toolBlock('Bash'), 'assistant')).toBe('assistant:tool:Bash');
    });

    it('resolves Edit → assistant:tool:Edit', () => {
      expect(resolveBlockType(toolBlock('Edit'), 'assistant')).toBe('assistant:tool:Edit');
    });

    it('resolves Read → assistant:tool:Read', () => {
      expect(resolveBlockType(toolBlock('Read'), 'assistant')).toBe('assistant:tool:Read');
    });

    it('resolves Write → assistant:tool:Write', () => {
      expect(resolveBlockType(toolBlock('Write'), 'assistant')).toBe('assistant:tool:Write');
    });

    it('resolves Glob → assistant:tool:Glob', () => {
      expect(resolveBlockType(toolBlock('Glob'), 'assistant')).toBe('assistant:tool:Glob');
    });

    it('resolves Grep → assistant:tool:Grep', () => {
      expect(resolveBlockType(toolBlock('Grep'), 'assistant')).toBe('assistant:tool:Grep');
    });

    it('resolves Task → assistant:tool:Task', () => {
      expect(resolveBlockType(toolBlock('Task'), 'assistant')).toBe('assistant:tool:Task');
    });

    it('resolves WebSearch → assistant:tool:WebSearch', () => {
      expect(resolveBlockType(toolBlock('WebSearch'), 'assistant')).toBe('assistant:tool:WebSearch');
    });

    it('resolves WebFetch → assistant:tool:WebFetch', () => {
      expect(resolveBlockType(toolBlock('WebFetch'), 'assistant')).toBe('assistant:tool:WebFetch');
    });

    it('resolves TodoWrite → assistant:tool:TodoWrite', () => {
      expect(resolveBlockType(toolBlock('TodoWrite'), 'assistant')).toBe('assistant:tool:TodoWrite');
    });

    it('resolves AskUserQuestion → assistant:tool:AskUserQuestion', () => {
      expect(resolveBlockType(toolBlock('AskUserQuestion'), 'assistant')).toBe('assistant:tool:AskUserQuestion');
    });

    it('resolves Skill → assistant:tool:Skill', () => {
      expect(resolveBlockType(toolBlock('Skill'), 'assistant')).toBe('assistant:tool:Skill');
    });

    it('resolves ExitPlanMode → assistant:tool:ExitPlanMode', () => {
      expect(resolveBlockType(toolBlock('ExitPlanMode'), 'assistant')).toBe('assistant:tool:ExitPlanMode');
    });

    it('resolves EnterPlanMode → assistant:tool:EnterPlanMode', () => {
      expect(resolveBlockType(toolBlock('EnterPlanMode'), 'assistant')).toBe('assistant:tool:EnterPlanMode');
    });

    it('resolves MultiEdit → assistant:tool:MultiEdit', () => {
      expect(resolveBlockType(toolBlock('MultiEdit'), 'assistant')).toBe('assistant:tool:MultiEdit');
    });

    it('resolves LS → assistant:tool:LS', () => {
      expect(resolveBlockType(toolBlock('LS'), 'assistant')).toBe('assistant:tool:LS');
    });

    it('resolves NotebookEdit → assistant:tool:NotebookEdit', () => {
      expect(resolveBlockType(toolBlock('NotebookEdit'), 'assistant')).toBe('assistant:tool:NotebookEdit');
    });

    it('resolves TaskOutput → assistant:tool:TaskOutput', () => {
      expect(resolveBlockType(toolBlock('TaskOutput'), 'assistant')).toBe('assistant:tool:TaskOutput');
    });

    it('resolves TaskStop → assistant:tool:TaskStop', () => {
      expect(resolveBlockType(toolBlock('TaskStop'), 'assistant')).toBe('assistant:tool:TaskStop');
    });

    it('resolves ListMcpResources → assistant:tool:ListMcpResources', () => {
      expect(resolveBlockType(toolBlock('ListMcpResources'), 'assistant')).toBe('assistant:tool:ListMcpResources');
    });

    it('resolves ReadMcpResource → assistant:tool:ReadMcpResource', () => {
      expect(resolveBlockType(toolBlock('ReadMcpResource'), 'assistant')).toBe('assistant:tool:ReadMcpResource');
    });
  });

  // ── MCP tools ────────────────────────────────────────────────────────

  describe('MCP tools (mcp__*)', () => {
    function mcpTool(name: string): ContentBlock {
      return { type: 'tool_use', id: `tu_mcp`, name, input: {} };
    }

    it('resolves mcp__server__action to assistant:tool:mcp:server:action', () => {
      expect(resolveBlockType(mcpTool('mcp__claude-in-chrome__screenshot'), 'assistant'))
        .toBe('assistant:tool:mcp:claude-in-chrome:screenshot');
    });

    it('resolves mcp__server__nested__action with colons', () => {
      expect(resolveBlockType(mcpTool('mcp__myserver__deep__nested'), 'assistant'))
        .toBe('assistant:tool:mcp:myserver:deep:nested');
    });

    it('handles mcp__ with only server name', () => {
      expect(resolveBlockType(mcpTool('mcp__server'), 'assistant'))
        .toBe('assistant:tool:mcp:server:unknown');
    });

    it('handles bare mcp__ prefix', () => {
      expect(resolveBlockType(mcpTool('mcp__'), 'assistant'))
        .toBe('assistant:tool:mcp:unknown:unknown');
    });
  });

  // ── Unknown tools ────────────────────────────────────────────────────

  describe('unknown tools', () => {
    it('resolves unknown tool names to assistant:tool:unknown', () => {
      const block: ContentBlock = {
        type: 'tool_use',
        id: 'tu_custom',
        name: 'SomeCustomTool',
        input: {},
      };
      expect(resolveBlockType(block, 'assistant')).toBe('assistant:tool:unknown');
    });
  });

  // ── Malformed tool_use blocks (runtime safety) ────────────────────────

  describe('malformed tool_use blocks', () => {
    it('handles null name gracefully', () => {
      const block = { type: 'tool_use', id: 'x', name: null, input: {} } as unknown as ContentBlock;
      expect(resolveBlockType(block, 'assistant')).toBe('assistant:tool:unknown');
    });

    it('handles undefined name gracefully', () => {
      const block = { type: 'tool_use', id: 'x', input: {} } as unknown as ContentBlock;
      expect(resolveBlockType(block, 'assistant')).toBe('assistant:tool:unknown');
    });

    it('handles numeric name gracefully', () => {
      const block = { type: 'tool_use', id: 'x', name: 42, input: {} } as unknown as ContentBlock;
      expect(resolveBlockType(block, 'assistant')).toBe('assistant:tool:unknown');
    });
  });

  // ── Unknown block types ──────────────────────────────────────────────

  it('resolves unknown block types to "assistant:unknown"', () => {
    // Force an unknown type past TypeScript
    const block = { type: 'server_event' } as unknown as ContentBlock;
    expect(resolveBlockType(block, 'assistant')).toBe('assistant:unknown');
  });
});
