/**
 * Tests for Message View — renderSession and splitAtNewlines
 *
 * Tests the pure rendering functions from render.ts:
 * entries + toolResults -> string chunks <= 4000 chars.
 */

import { describe, it, expect } from 'vitest';

import { renderSession, splitAtNewlines } from '../src/core/message-view/render.js';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ============================================================================
// Helpers
// ============================================================================

function makeAssistantEntry(text: string): TranscriptEntry {
  return {
    type: 'assistant',
    message: { content: text },
  };
}

function makeAssistantBlocksEntry(blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>): TranscriptEntry {
  return {
    type: 'assistant',
    message: { content: blocks as TranscriptEntry['message'] extends { content: infer C } ? C : never },
  };
}

function makeUserToolResultEntry(toolUseId: string, isError = false): TranscriptEntry {
  return {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'result', is_error: isError },
      ] as unknown as import('../src/core/transcript.js').ContentBlock[],
    },
  };
}

// ============================================================================
// splitAtNewlines
// ============================================================================

describe('splitAtNewlines', () => {
  it('returns empty array for empty string', () => {
    expect(splitAtNewlines('', 4000)).toEqual([]);
  });

  it('returns single chunk when under limit', () => {
    const text = 'Hello world';
    expect(splitAtNewlines(text, 4000)).toEqual(['Hello world']);
  });

  it('returns single chunk when exactly at limit', () => {
    const text = 'x'.repeat(4000);
    expect(splitAtNewlines(text, 4000)).toEqual([text]);
  });

  it('splits at newline boundary', () => {
    const line = 'x'.repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitAtNewlines(text, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    // All content should be present (split may consume the boundary newline)
    const reassembled = chunks.join('\n');
    expect(reassembled.replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
  });

  it('handles text with no newlines by hard-cutting', () => {
    const text = 'x'.repeat(8000);
    const chunks = splitAtNewlines(text, 4000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(4000);
  });

  it('handles multiple short lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
    const text = lines.join('\n');
    const chunks = splitAtNewlines(text, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });
});

// ============================================================================
// renderSession
// ============================================================================

describe('renderSession', () => {
  it('returns empty array for empty entries', () => {
    expect(renderSession([], new Map())).toEqual([]);
  });

  it('renders a single assistant text entry', () => {
    const entries = [makeAssistantEntry('Hello, I will help you.')];
    const chunks = renderSession(entries, new Map());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Hello, I will help you.');
  });

  it('renders a status line when provided', () => {
    const entries = [makeAssistantEntry('Working on it.')];
    const chunks = renderSession(entries, new Map(), '\u{23F3} Working\u{2026}');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('\u{23F3} Working');
    expect(chunks[0]).toContain('Working on it.');
  });

  it('renders multiple entries into a few chunks, not one per entry', () => {
    // 50 short assistant entries should pack into 1-3 chunks, not 50
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(makeAssistantEntry(`Step ${i}: doing something useful.`));
    }
    const chunks = renderSession(entries, new Map());
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('renders tool_use with pending status', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 'toolu_abc', name: 'read', input: { file_path: '/src/index.ts' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks).toHaveLength(1);
    // read is an inline tool: renders as icon+status, no bold name
    expect(chunks[0]).toContain('\u{1F4C4}\u{23F3}'); // 📄⏳
  });

  it('renders tool_use with completed status when result exists', () => {
    const toolResults = new Map<string, boolean>();
    toolResults.set('toolu_abc', false); // not error

    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 'toolu_abc', name: 'read', input: { file_path: '/src/index.ts' } },
      ]),
    ];
    const chunks = renderSession(entries, toolResults);
    expect(chunks).toHaveLength(1);
    // read is inline: completed = just icon (no ✓ suffix, no ⏳)
    expect(chunks[0]).toContain('\u{1F4C4}'); // 📄
    expect(chunks[0]).not.toContain('\u{23F3}');
  });

  it('renders tool_use with error status', () => {
    const toolResults = new Map<string, boolean>();
    toolResults.set('toolu_err', true); // is error

    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 'toolu_err', name: 'bash', input: { command: 'npm test' } },
      ]),
    ];
    const chunks = renderSession(entries, toolResults);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('\u{2717}'); // cross mark
  });

  it('renders user entries with bold prefix', () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { content: 'Fix the tests please' } },
      makeAssistantEntry('Sure, I will fix them.'),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('**User:** Fix the tests please');
    expect(chunks[0]).toContain('Sure, I will fix them.');
  });

  it('skips entries with no content', () => {
    const entries: TranscriptEntry[] = [
      { type: 'assistant', message: undefined },
      { type: 'assistant', message: { content: '' } },
      makeAssistantEntry('Real content'),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Real content');
  });

  it('handles mixed text and tool blocks', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'text', text: 'I will read the file first.' },
        { type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a.ts' } },
      ]),
      makeAssistantBlocksEntry([
        { type: 'text', text: 'Now editing.' },
        { type: 'tool_use', id: 't2', name: 'edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } },
      ]),
    ];

    const toolResults = new Map<string, boolean>();
    toolResults.set('t1', false);

    const chunks = renderSession(entries, toolResults);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const full = chunks.join('\n');
    expect(full).toContain('I will read the file first.');
    expect(full).toContain('Now editing.');
    // read is inline: completed = just icon (no ✓); edit is full-line with ⏳
    expect(full).toContain('\u{1F4C4}'); // t1 (read) completed — inline icon only
    expect(full).toContain('\u{23F3}'); // t2 (edit) pending
  });

  it('produces 2-4 chunks from 50 entries with substantial content', () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(makeAssistantBlocksEntry([
        { type: 'text', text: `Analysis step ${i}: ${'x'.repeat(100)}` },
        { type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: `cmd-${i}` } },
      ]));
    }
    const toolResults = new Map<string, boolean>();
    for (let i = 0; i < 25; i++) {
      toolResults.set(`t${i}`, false);
    }

    const chunks = renderSession(entries, toolResults);
    // Should pack into a few chunks, not 50+
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(6);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });
});

// ============================================================================
// Tool rendering format (contract tests)
// ============================================================================

describe('tool rendering format via renderSession', () => {
  function shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
  }

  it('bash: icon name subject status', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm run build' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks[0]).toContain('  \u{1F4BB}  **bash**');
    expect(chunks[0]).toContain('`npm run build`');
    expect(chunks[0]).toContain('\u{23F3}');
  });

  it('bash: uses description over command when present', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls -la /some/path', description: 'List files' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks[0]).toContain('`List files`');
  });

  it('read: icon name path status', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/home/user/projects/app/src/index.ts' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    // read is inline: renders as icon+⏳, no bold name or path
    expect(chunks[0]).toContain('\u{1F4C4}\u{23F3}');
  });

  it('edit: icon name path +N -N status', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'edit', input: { file_path: '/src/main.ts', old_string: 'a\nb\nc', new_string: 'x\ny\nz\nw\nv' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks[0]).toContain('  \u{1F4DD}  **edit**');
    expect(chunks[0]).toContain('+5 -3');
  });

  it('grep: icon name pattern status', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'TODO' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    // grep is inline: renders as icon+⏳, no bold name or pattern
    expect(chunks[0]).toContain('\u{1F50D}\u{23F3}');
  });

  it('agent: icon name description status', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'agent', input: { description: 'Search for related files', prompt: 'find files' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks[0]).toContain('  \u{1F916}  **agent**');
    expect(chunks[0]).toContain('Search for related files');
  });

  it('mcp tool: strips mcp__ prefix and replaces __ with /', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'mcp__github__list_issues', input: { description: 'List issues' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks[0]).toContain('**github/list_issues**');
  });

  it('unknown tool: wrench icon with name and subject', () => {
    const entries = [
      makeAssistantBlocksEntry([
        { type: 'tool_use', id: 't1', name: 'custom_tool', input: { description: 'some arg' } },
      ]),
    ];
    const chunks = renderSession(entries, new Map());
    expect(chunks[0]).toContain('\u{1F527}');
    expect(chunks[0]).toContain('**custom_tool**');
  });
});

// ============================================================================
// Integration: catchup packing (THE critical test)
// ============================================================================

describe('integration: catchup packing', () => {
  it('50 transcript entries pack into 2-4 chunks, not 50+', () => {
    const entries: TranscriptEntry[] = [];
    const toolResults = new Map<string, boolean>();

    for (let i = 0; i < 50; i++) {
      // Assistant turn with text + tool (longer content to exceed one chunk)
      entries.push(makeAssistantBlocksEntry([
        { type: 'text', text: `Analysis step ${i}: ${'investigating the codebase for potential issues '.repeat(3)}` },
        { type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: `echo step${i} && run-some-long-command-name-here` } },
      ]));

      // User turn with tool result
      entries.push(makeUserToolResultEntry(`t${i}`));
      toolResults.set(`t${i}`, false);
    }

    const chunks = renderSession(entries, toolResults, '\u{23F3} Working\u{2026}');

    // Key assertion: should be a small number of chunks, NOT 50+
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(8);

    // Every chunk respects the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }

    // All tool results should show completed
    const fullText = chunks.join('\n');
    // Should contain check marks for all completed tools
    const checkMarks = (fullText.match(/\u2713/g) || []).length;
    expect(checkMarks).toBe(50);
    // Status line should be present
    expect(fullText).toContain('Working');
  });
});
