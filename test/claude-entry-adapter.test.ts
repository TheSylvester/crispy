/**
 * Tests for adaptClaudeEntry content block sanitization.
 *
 * Validates that the adapter coerces malformed content blocks to safe
 * defaults so downstream consumers can trust TypeScript types at face value.
 */

import { describe, it, expect } from 'vitest';
import { adaptClaudeEntry } from '../src/core/adapters/claude/claude-entry-adapter.js';
import type { ContentBlock, ToolUseBlock } from '../src/core/transcript.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal assistant entry with the given content blocks. */
function makeAssistantEntry(content: unknown[]) {
  return {
    type: 'assistant',
    uuid: 'test-uuid',
    sessionId: 'test-session',
    message: {
      role: 'assistant',
      content,
    },
  };
}

/** Build a minimal progress entry with the given content blocks. */
function makeProgressEntry(content: unknown[]) {
  return {
    type: 'progress',
    uuid: 'test-uuid',
    sessionId: 'test-session',
    data: {
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content,
        },
      },
    },
  };
}

/** Extract content blocks from an adapted entry. */
function getContentBlocks(raw: Record<string, unknown>): ContentBlock[] {
  const entry = adaptClaudeEntry(raw);
  expect(entry).not.toBeNull();
  const content = entry!.message?.content;
  expect(Array.isArray(content)).toBe(true);
  return content as ContentBlock[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Content block sanitization', () => {
  describe('standard entry path', () => {
    it('coerces tool_use block with missing name to "<unknown>"', () => {
      const blocks = getContentBlocks(
        makeAssistantEntry([
          { type: 'tool_use', id: 'tu-1', input: { command: 'ls' } },
        ]),
      );

      expect(blocks).toHaveLength(1);
      const block = blocks[0] as ToolUseBlock;
      expect(block.type).toBe('tool_use');
      expect(block.name).toBe('<unknown>');
    });

    it('coerces tool_use block with name: null to "<unknown>"', () => {
      const blocks = getContentBlocks(
        makeAssistantEntry([
          { type: 'tool_use', id: 'tu-2', name: null, input: { command: 'ls' } },
        ]),
      );

      expect(blocks).toHaveLength(1);
      const block = blocks[0] as ToolUseBlock;
      expect(block.type).toBe('tool_use');
      expect(block.name).toBe('<unknown>');
    });

    it('passes through tool_use block with valid string name unchanged', () => {
      const blocks = getContentBlocks(
        makeAssistantEntry([
          { type: 'tool_use', id: 'tu-3', name: 'Bash', input: { command: 'ls' } },
        ]),
      );

      expect(blocks).toHaveLength(1);
      const block = blocks[0] as ToolUseBlock;
      expect(block.type).toBe('tool_use');
      expect(block.name).toBe('Bash');
    });
  });

  describe('progress entry path', () => {
    it('coerces tool_use block with missing name to "<unknown>"', () => {
      const blocks = getContentBlocks(
        makeProgressEntry([
          { type: 'tool_use', id: 'tu-4', input: { command: 'ls' } },
        ]),
      );

      expect(blocks).toHaveLength(1);
      const block = blocks[0] as ToolUseBlock;
      expect(block.type).toBe('tool_use');
      expect(block.name).toBe('<unknown>');
    });
  });

  describe('non-tool_use blocks pass through', () => {
    it('does not modify text blocks', () => {
      const blocks = getContentBlocks(
        makeAssistantEntry([
          { type: 'text', text: 'hello world' },
        ]),
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ type: 'text', text: 'hello world' });
    });
  });

  describe('string content passthrough', () => {
    it('does not modify string message content', () => {
      const entry = adaptClaudeEntry({
        type: 'user',
        uuid: 'test-uuid',
        sessionId: 'test-session',
        message: {
          role: 'user',
          content: 'plain string message',
        },
      });

      expect(entry).not.toBeNull();
      expect(entry!.message?.content).toBe('plain string message');
    });
  });
});
