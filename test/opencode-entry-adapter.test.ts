/**
 * Tests for opencode-entry-adapter.ts — Tier 1 (pure functions, no I/O)
 *
 * One describe per OpenCode Part type. Inline synthetic fixtures.
 */

import { describe, it, expect } from 'vitest';
import {
  adaptOpenCodePart,
  normalizeToolName,
  parseTaskResult,
  extractChildSessionId,
  extractContextUsage,
  extractRetryError,
} from '../src/core/adapters/opencode/opencode-entry-adapter.js';
import type { Part, TextPart, ReasoningPart, ToolPart, FilePart, StepFinishPart, RetryPart, CompactionPart, StepStartPart, SnapshotPart, PatchPart, AgentPart } from '@opencode-ai/sdk/client';

const SESSION_ID = 'test-session-123';

function basePart(overrides: Record<string, unknown> = {}) {
  return {
    id: 'part-1',
    sessionID: SESSION_ID,
    messageID: 'msg-1',
    ...overrides,
  };
}

describe('TextPart', () => {
  it('maps to assistant entry with TextBlock', () => {
    const part: TextPart = {
      ...basePart(),
      type: 'text',
      text: 'Hello world',
    };

    const entries = adaptOpenCodePart(part, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('assistant');
    expect(entries[0].vendor).toBe('opencode');
    expect(entries[0].message.role).toBe('assistant');
    expect(entries[0].message.content[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('skips when ignored is true', () => {
    const part: TextPart = {
      ...basePart(),
      type: 'text',
      text: 'ignored text',
      ignored: true,
    };

    const entries = adaptOpenCodePart(part, SESSION_ID);
    expect(entries).toHaveLength(0);
  });

  it('preserves synthetic flag in metadata', () => {
    const part: TextPart = {
      ...basePart(),
      type: 'text',
      text: 'synthetic text',
      synthetic: true,
    };

    const entries = adaptOpenCodePart(part, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata?.synthetic).toBe(true);
  });
});

describe('ReasoningPart', () => {
  it('maps to assistant entry with ThinkingBlock', () => {
    const part: ReasoningPart = {
      ...basePart(),
      type: 'reasoning',
      text: 'Let me think...',
      time: { start: 1000, end: 2000 },
    };

    const entries = adaptOpenCodePart(part, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('assistant');
    expect(entries[0].vendor).toBe('opencode');
    expect(entries[0].message.content[0]).toEqual({ type: 'thinking', thinking: 'Let me think...' });
    expect(entries[0].metadata?.time).toEqual({ start: 1000, end: 2000 });
  });
});

describe('ToolPart', () => {
  function toolPart(state: ToolPart['state'], tool = 'bash'): ToolPart {
    return {
      ...basePart(),
      type: 'tool',
      callID: 'call-1',
      tool,
      state,
    };
  }

  describe('pending', () => {
    it('emits 1 entry with ToolUseBlock only', () => {
      const part = toolPart({
        status: 'pending',
        input: { command: 'ls' },
        raw: 'ls',
      });

      const entries = adaptOpenCodePart(part, SESSION_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
      expect(entries[0].message.content[0]).toMatchObject({
        type: 'tool_use',
        id: 'call-1',
        name: 'Bash',
      });
    });
  });

  describe('running', () => {
    it('emits 1 entry with ToolUseBlock (in-progress)', () => {
      const part = toolPart({
        status: 'running',
        input: { command: 'ls -la' },
        title: 'Running ls',
        time: { start: 1000 },
      });

      const entries = adaptOpenCodePart(part, SESSION_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
    });
  });

  describe('completed', () => {
    it('emits 2 entries: ToolUseBlock + ToolResultBlock', () => {
      const part = toolPart({
        status: 'completed',
        input: { command: 'ls' },
        output: 'file1.txt\nfile2.txt',
        title: 'Listed files',
        metadata: {},
        time: { start: 1000, end: 2000 },
      });

      const entries = adaptOpenCodePart(part, SESSION_ID);
      expect(entries).toHaveLength(2);

      // First: assistant with ToolUseBlock
      expect(entries[0].type).toBe('assistant');
      expect(entries[0].message.content[0]).toMatchObject({
        type: 'tool_use',
        id: 'call-1',
        name: 'Bash',
      });

      // Second: result with ToolResultBlock
      expect(entries[1].type).toBe('result');
      expect(entries[1].uuid).toBe('call-1-result');
      expect(entries[1].parentUuid).toBe('part-1');
      expect(entries[1].message.role).toBe('tool');
      expect(entries[1].message.content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'file1.txt\nfile2.txt',
        is_error: false,
      });
    });
  });

  describe('error', () => {
    it('emits 2 entries with is_error: true', () => {
      const part = toolPart({
        status: 'error',
        input: { command: 'bad-command' },
        error: 'command not found',
        time: { start: 1000, end: 2000 },
      });

      const entries = adaptOpenCodePart(part, SESSION_ID);
      expect(entries).toHaveLength(2);
      expect(entries[1].message.content[0]).toMatchObject({
        type: 'tool_result',
        is_error: true,
        content: 'command not found',
      });
    });
  });

  describe('Task tool with agentId', () => {
    it('extracts agentId from metadata.sessionId on completed state', () => {
      const part = toolPart({
        status: 'completed',
        input: { prompt: 'do something' },
        output: 'task_id: child-123\n\n<task_result>\nDone!\n</task_result>',
        title: 'Task completed',
        metadata: { sessionId: 'child-123' },
        time: { start: 1000, end: 2000 },
      }, 'task');

      const entries = adaptOpenCodePart(part, SESSION_ID);
      expect(entries).toHaveLength(2);
      expect(entries[1].toolUseResult?.agentId).toBe('child-123');
    });
  });
});

describe('FilePart', () => {
  it('maps to user entry with file info in metadata', () => {
    const part: FilePart = {
      ...basePart(),
      type: 'file',
      mime: 'text/plain',
      filename: 'test.txt',
      url: 'file:///tmp/test.txt',
    };

    const entries = adaptOpenCodePart(part, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('user');
    expect(entries[0].vendor).toBe('opencode');
    expect(entries[0].metadata?.mime).toBe('text/plain');
    expect(entries[0].metadata?.filename).toBe('test.txt');
    expect(entries[0].metadata?.url).toBe('file:///tmp/test.txt');
  });
});

describe('SubtaskPart', () => {
  it('maps to assistant entry with Task ToolUseBlock', () => {
    const part: Extract<Part, { type: 'subtask' }> = {
      ...basePart(),
      type: 'subtask',
      prompt: 'Fix the bug',
      description: 'Fix the null pointer bug in main.ts',
      agent: 'coder',
    };

    const entries = adaptOpenCodePart(part, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('assistant');
    expect(entries[0].message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Task',
      input: {
        prompt: 'Fix the bug',
        description: 'Fix the null pointer bug in main.ts',
        subagent_type: 'coder',
      },
    });
  });
});

describe('Skipped part types', () => {
  it.each([
    ['compaction', { ...basePart(), type: 'compaction', auto: true }],
    ['step-start', { ...basePart(), type: 'step-start' }],
    ['step-finish', { ...basePart(), type: 'step-finish', reason: 'done', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
    ['snapshot', { ...basePart(), type: 'snapshot', snapshot: 'abc123' }],
    ['patch', { ...basePart(), type: 'patch', hash: 'abc', files: [] }],
    ['agent', { ...basePart(), type: 'agent', name: 'coder' }],
    ['retry', { ...basePart(), type: 'retry', attempt: 1, error: { name: 'APIError' as const, data: { message: 'rate limited', isRetryable: true } }, time: { created: 1000 } }],
  ] as const)('%s → empty array', (_name, part) => {
    const entries = adaptOpenCodePart(part as Part, SESSION_ID);
    expect(entries).toHaveLength(0);
  });
});

describe('Tool name normalization', () => {
  it.each([
    ['bash', 'Bash'],
    ['edit', 'Edit'],
    ['write', 'Write'],
    ['read', 'Read'],
    ['glob', 'Glob'],
    ['grep', 'Grep'],
    ['webfetch', 'WebFetch'],
    ['websearch', 'WebSearch'],
    ['todowrite', 'TodoWrite'],
    ['task', 'Task'],
    ['apply_patch', 'Edit'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeToolName(input)).toBe(expected);
  });

  it('MCP tools pass through', () => {
    expect(normalizeToolName('mcp__server__tool')).toBe('mcp__server__tool');
  });

  it('unknown tools pass through', () => {
    expect(normalizeToolName('some_custom_tool')).toBe('some_custom_tool');
  });
});

describe('Subtask result parsing', () => {
  it('extracts body between task_result tags', () => {
    const output = 'task_id: child-123\n\n<task_result>\nDone successfully!\n</task_result>';
    expect(parseTaskResult(output)).toBe('Done successfully!');
  });

  it('returns full output if tags not found', () => {
    expect(parseTaskResult('plain text result')).toBe('plain text result');
  });

  it('extracts child session ID', () => {
    const output = 'task_id: child-123\n\n<task_result>\nDone!\n</task_result>';
    expect(extractChildSessionId(output)).toBe('child-123');
  });

  it('returns undefined if no task_id', () => {
    expect(extractChildSessionId('no id here')).toBeUndefined();
  });
});

describe('Context usage extraction', () => {
  it('extracts tokens and cost from StepFinishPart', () => {
    const part: StepFinishPart = {
      ...basePart(),
      type: 'step-finish',
      reason: 'done',
      cost: 0.05,
      tokens: {
        input: 1000,
        output: 500,
        reasoning: 200,
        cache: { read: 100, write: 50 },
      },
    };

    const usage = extractContextUsage(part);
    expect(usage.tokens.input).toBe(1000);
    expect(usage.tokens.output).toBe(500);
    expect(usage.tokens.cacheRead).toBe(100);
    expect(usage.tokens.cacheCreation).toBe(50);
    expect(usage.totalTokens).toBe(1650);
    expect(usage.totalCostUsd).toBe(0.05);
  });
});

describe('Retry error extraction', () => {
  it('formats error message', () => {
    const part: RetryPart = {
      ...basePart(),
      type: 'retry',
      attempt: 2,
      error: {
        name: 'APIError',
        data: { message: 'rate limited', isRetryable: true },
      },
      time: { created: 1000 },
    };

    expect(extractRetryError(part)).toBe('API retry attempt 2: rate limited');
  });
});

describe('Universal contract', () => {
  it('all entries have vendor: opencode', () => {
    const parts: Part[] = [
      { ...basePart(), type: 'text', text: 'hello' } as TextPart,
      { ...basePart(), type: 'reasoning', text: 'thinking', time: { start: 1, end: 2 } } as ReasoningPart,
      { ...basePart(), type: 'file', mime: 'text/plain', url: 'x', filename: 'f' } as FilePart,
    ];

    for (const part of parts) {
      const entries = adaptOpenCodePart(part, SESSION_ID);
      for (const entry of entries) {
        expect(entry.vendor).toBe('opencode');
        expect(entry.type).toBeTruthy();
        expect(entry.message.content).toBeDefined();
      }
    }
  });
});
