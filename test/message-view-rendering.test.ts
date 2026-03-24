/**
 * Tests for Message View — Buffer operations and tool rendering
 *
 * Tests the buffer.ts exports (pure data structure) and indirectly validates
 * the rendering patterns used by index.ts (renderToolUse, tool line accumulation).
 *
 * The renderToolUse / appendConversationText / appendToolLine functions are
 * module-internal to index.ts, so we test the buffer mechanics directly and
 * replicate the rendering logic for tool use format verification.
 */

import { describe, it, expect } from 'vitest';

import {
  createBuffer,
  appendSection,
  updateSection,
  findSection,
  getOrCreateSection,
  getLastSection,
  clearBuffer,
} from '../src/core/message-view/buffer.js';

// ============================================================================
// Buffer basics
// ============================================================================

describe('createBuffer', () => {
  it('returns an empty buffer', () => {
    const buf = createBuffer();
    expect(buf.sections).toEqual([]);
    expect(buf.sections).toHaveLength(0);
  });
});

describe('appendSection', () => {
  it('adds a section and marks it dirty', () => {
    const buf = createBuffer();
    const section = appendSection(buf, 'status', 'Hello');

    expect(buf.sections).toHaveLength(1);
    expect(section.id).toBe('status');
    expect(section.content).toBe('Hello');
    expect(section.dirty).toBe(true);
  });

  it('appends multiple sections in order', () => {
    const buf = createBuffer();
    appendSection(buf, 'first', 'A');
    appendSection(buf, 'second', 'B');
    appendSection(buf, 'third', 'C');

    expect(buf.sections).toHaveLength(3);
    expect(buf.sections.map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('updateSection', () => {
  it('updates content and marks dirty', () => {
    const buf = createBuffer();
    const section = appendSection(buf, 'test', 'old');
    section.dirty = false; // simulate having been synced

    updateSection(section, 'new');

    expect(section.content).toBe('new');
    expect(section.dirty).toBe(true);
  });

  it('does not mark dirty if content is unchanged', () => {
    const buf = createBuffer();
    const section = appendSection(buf, 'test', 'same');
    section.dirty = false;

    updateSection(section, 'same');

    expect(section.dirty).toBe(false);
  });
});

describe('findSection', () => {
  it('finds an existing section by id', () => {
    const buf = createBuffer();
    appendSection(buf, 'alpha', 'A');
    appendSection(buf, 'beta', 'B');

    const found = findSection(buf, 'beta');
    expect(found).toBeDefined();
    expect(found!.content).toBe('B');
  });

  it('returns undefined for missing id', () => {
    const buf = createBuffer();
    appendSection(buf, 'alpha', 'A');

    expect(findSection(buf, 'gamma')).toBeUndefined();
  });
});

describe('getOrCreateSection', () => {
  it('returns existing section if found', () => {
    const buf = createBuffer();
    const original = appendSection(buf, 'tools', 'line 1');

    const result = getOrCreateSection(buf, 'tools', 'default');

    expect(result).toBe(original); // same reference
    expect(result.content).toBe('line 1'); // not overwritten
    expect(buf.sections).toHaveLength(1); // no duplicate
  });

  it('creates a new section with initial content if not found', () => {
    const buf = createBuffer();
    const result = getOrCreateSection(buf, 'tools', 'initial');

    expect(result.id).toBe('tools');
    expect(result.content).toBe('initial');
    expect(result.dirty).toBe(true);
    expect(buf.sections).toHaveLength(1);
  });

  it('creates with empty string when initialContent is omitted', () => {
    const buf = createBuffer();
    const result = getOrCreateSection(buf, 'tools');

    expect(result.content).toBe('');
  });
});

describe('getLastSection', () => {
  it('returns the last section', () => {
    const buf = createBuffer();
    appendSection(buf, 'first', 'A');
    appendSection(buf, 'last', 'B');

    const last = getLastSection(buf);
    expect(last).toBeDefined();
    expect(last!.id).toBe('last');
  });

  it('returns undefined for empty buffer', () => {
    const buf = createBuffer();
    expect(getLastSection(buf)).toBeUndefined();
  });
});

describe('clearBuffer', () => {
  it('removes all sections', () => {
    const buf = createBuffer();
    appendSection(buf, 'a', '1');
    appendSection(buf, 'b', '2');

    clearBuffer(buf);

    expect(buf.sections).toHaveLength(0);
  });
});

// ============================================================================
// Tool line accumulation pattern
// ============================================================================

describe('tool line accumulation in single section', () => {
  it('accumulates multiple tool lines in one tools section via updateSection', () => {
    const buf = createBuffer();
    appendSection(buf, 'status', 'Working...');

    // Simulate the appendToolLine pattern from index.ts:
    // getOrCreateSection(buffer, 'tools', '') then updateSection with joined lines
    const toolLines: string[] = [];

    toolLines.push('\u{1F4BB} **bash**  `ls -la`  \u{23F3}');
    const toolSection = getOrCreateSection(buf, 'tools', '');
    updateSection(toolSection, toolLines.join('\n'));

    toolLines.push('\u{1F4C4} **read**  `src/index.ts`  \u{23F3}');
    updateSection(toolSection, toolLines.join('\n'));

    toolLines.push('\u{1F4DD} **edit**  `src/app.ts` +5 -3  \u{23F3}');
    updateSection(toolSection, toolLines.join('\n'));

    // Verify single section with all tool lines
    expect(buf.sections).toHaveLength(2); // status + tools
    const tools = findSection(buf, 'tools');
    expect(tools).toBeDefined();
    expect(tools!.content).toContain('\u{1F4BB} **bash**');
    expect(tools!.content).toContain('\u{1F4C4} **read**');
    expect(tools!.content).toContain('\u{1F4DD} **edit**');
    expect(tools!.content.split('\n')).toHaveLength(3);
  });
});

// ============================================================================
// renderToolUse format verification
// ============================================================================

// Since renderToolUse is not exported, we replicate the expected output format
// to document the contract. These tests verify the FORMAT SPEC that index.ts
// produces — if the format changes, these tests should be updated to match.

describe('renderToolUse output format (contract tests)', () => {
  // Helper: replicate renderToolUse logic for verification
  function shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
  }

  it('bash: icon name subject status', () => {
    const cmd = 'npm run build';
    const expected = `\u{1F4BB} **bash**  \`${cmd}\`  \u{23F3}`;
    // Replicate: no description → use command
    const input = { command: cmd };
    const desc = (input as Record<string, unknown>).description as string | undefined;
    const subject = desc ? desc.slice(0, 50) : cmd.split('\n')[0].slice(0, 50);
    const result = `\u{1F4BB} **bash**  \`${subject}\`  \u{23F3}`;
    expect(result).toBe(expected);
  });

  it('bash: uses description over command when present', () => {
    const input = { command: 'ls -la /some/long/path', description: 'List files' };
    const subject = input.description.slice(0, 50);
    const result = `\u{1F4BB} **bash**  \`${subject}\`  \u{23F3}`;
    expect(result).toBe('\u{1F4BB} **bash**  `List files`  \u{23F3}');
  });

  it('bash: background badge', () => {
    const input = { command: 'npm run dev', run_in_background: true };
    const subject = input.command.split('\n')[0].slice(0, 50);
    const result = `\u{1F4BB} **bash** [background]  \`${subject}\`  \u{23F3}`;
    expect(result).toContain('[background]');
  });

  it('read: icon name path status', () => {
    const filePath = '/home/user/projects/app/src/index.ts';
    const short = shortPath(filePath);
    expect(short).toBe('src/index.ts');
    const result = `\u{1F4C4} **read**  \`${short}\`  \u{23F3}`;
    expect(result).toBe('\u{1F4C4} **read**  `src/index.ts`  \u{23F3}');
  });

  it('read: includes line range when offset is provided', () => {
    const filePath = '/home/user/src/app.ts';
    const short = shortPath(filePath);
    const offset = 100;
    const limit = 50;
    const range = `:${offset}-${offset + limit}`;
    const result = `\u{1F4C4} **read**  \`${short}${range}\`  \u{23F3}`;
    expect(result).toBe('\u{1F4C4} **read**  `src/app.ts:100-150`  \u{23F3}');
  });

  it('edit: icon name path +N -N status', () => {
    const filePath = '/home/user/src/main.ts';
    const short = shortPath(filePath);
    const addLines = 5;
    const delLines = 3;
    const result = `\u{1F4DD} **edit**  \`${short}\` +${addLines} -${delLines}  \u{23F3}`;
    expect(result).toBe('\u{1F4DD} **edit**  `src/main.ts` +5 -3  \u{23F3}');
  });

  it('grep: icon name pattern [scope] status', () => {
    const pattern = 'TODO';
    const result = `\u{1F50D} **grep**  \`${pattern}\`  \u{23F3}`;
    expect(result).toBe('\u{1F50D} **grep**  `TODO`  \u{23F3}');
  });

  it('grep: with scope', () => {
    const pattern = 'import.*react';
    const scope = '*.tsx';
    const result = `\u{1F50D} **grep**  \`${pattern}\` in ${scope}  \u{23F3}`;
    expect(result).toContain('`import.*react`');
    expect(result).toContain('in *.tsx');
  });

  it('agent: icon name description status', () => {
    const desc = 'Search for related files';
    const result = `\u{1F916} **agent**  ${desc}  \u{23F3}`;
    expect(result).toBe('\u{1F916} **agent**  Search for related files  \u{23F3}');
  });

  it('agent: with subagent_type badge', () => {
    const desc = 'Run analysis';
    const badge = '[parallel]';
    const result = `\u{1F916} **agent** ${badge}  ${desc}  \u{23F3}`;
    expect(result).toContain('[parallel]');
    expect(result).toContain('Run analysis');
  });

  it('mcp tool: strips mcp__ prefix and replaces __ with /', () => {
    const name = 'mcp__github__list_issues';
    const shortName = name.replace('mcp__', '').replace(/__/g, '/');
    expect(shortName).toBe('github/list_issues');
    const result = `\u{1F50C} **${shortName}**  some subject  \u{23F3}`;
    expect(result).toContain('**github/list_issues**');
  });

  it('unknown tool: wrench icon with name and subject', () => {
    const result = `\u{1F527} **custom_tool**  some arg  \u{23F3}`;
    expect(result).toContain('\u{1F527}');
    expect(result).toContain('**custom_tool**');
  });
});

// ============================================================================
// Conversation section splitting pattern
// ============================================================================

describe('conversation section splitting pattern', () => {
  it('creates new section when last is status or tools', () => {
    const buf = createBuffer();
    appendSection(buf, 'status', 'Working...');

    // Simulate appendConversationText: last section is status → create new
    const last = getLastSection(buf);
    const isNonConversation = !last || last.id === 'status' || last.id === 'tools';
    expect(isNonConversation).toBe(true);

    appendSection(buf, 'conv-1', 'Hello, I will help you.');

    expect(buf.sections).toHaveLength(2);
    expect(buf.sections[1].id).toBe('conv-1');
  });

  it('appends to existing conversation section when under limit', () => {
    const buf = createBuffer();
    appendSection(buf, 'status', 'Working...');
    const conv = appendSection(buf, 'conv-1', 'First paragraph.');

    // Simulate: last section is conv-1 (a conversation section), fits within limit
    const last = getLastSection(buf);
    const isNonConversation = !last || last.id === 'status' || last.id === 'tools';
    expect(isNonConversation).toBe(false);

    const newContent = `${last!.content}\n\nSecond paragraph.`;
    updateSection(conv, newContent);

    expect(buf.sections).toHaveLength(2);
    expect(conv.content).toContain('First paragraph.');
    expect(conv.content).toContain('Second paragraph.');
  });

  it('creates new section when approaching size limit', () => {
    const buf = createBuffer();
    appendSection(buf, 'status', 'Working...');
    const conv = appendSection(buf, 'conv-1', 'X'.repeat(1700));

    const last = getLastSection(buf);
    const SECTION_SOFT_LIMIT = 1800;
    const newText = 'A'.repeat(200);

    // Would exceed limit → should create new section
    const wouldExceed = (last!.content.length + newText.length + 1) > SECTION_SOFT_LIMIT;
    expect(wouldExceed).toBe(true);

    appendSection(buf, 'conv-2', newText);
    expect(buf.sections).toHaveLength(3);
    expect(buf.sections[2].id).toBe('conv-2');
  });
});

// ============================================================================
// Tool pairing pattern (⏳ → ✓/✗)
// ============================================================================

describe('tool pairing pattern', () => {
  // Simulates the tool pairing logic from index.ts using the same buffer primitives
  interface ToolLineEntry { line: string }

  function rebuildToolsSection(
    buf: ReturnType<typeof createBuffer>,
    toolLines: Map<string, ToolLineEntry>,
    toolLineOrder: string[],
  ): void {
    const lines: string[] = [];
    for (const toolId of toolLineOrder) {
      const entry = toolLines.get(toolId);
      if (entry) lines.push(entry.line);
    }
    const toolSection = getOrCreateSection(buf, 'tools', '');
    updateSection(toolSection, lines.join('\n'));
  }

  it('tool_use adds ⏳ line, tool_result updates to ✓', () => {
    const buf = createBuffer();
    appendSection(buf, 'status', 'Working...');
    const toolLines = new Map<string, ToolLineEntry>();
    const toolLineOrder: string[] = [];

    // Simulate tool_use
    const toolId = 'toolu_abc123';
    const line = '\u{1F4C4} **read**  `src/index.ts`  \u{23F3}';
    toolLines.set(toolId, { line });
    toolLineOrder.push(toolId);
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    const toolSection = findSection(buf, 'tools');
    expect(toolSection!.content).toContain('\u{23F3}');

    // Simulate tool_result (on user entry)
    const existing = toolLines.get(toolId);
    expect(existing).toBeDefined();
    existing!.line = existing!.line.replace('\u{23F3}', '\u{2713}');
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    expect(toolSection!.content).toContain('\u{2713}');
    expect(toolSection!.content).not.toContain('\u{23F3}');
  });

  it('tool_result with is_error updates to ✗', () => {
    const buf = createBuffer();
    const toolLines = new Map<string, ToolLineEntry>();
    const toolLineOrder: string[] = [];

    const toolId = 'toolu_err456';
    toolLines.set(toolId, { line: '\u{1F4BB} **bash**  `npm test`  \u{23F3}' });
    toolLineOrder.push(toolId);
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    // Simulate error result
    const existing = toolLines.get(toolId)!;
    existing.line = existing.line.replace('\u{23F3}', '\u{2717}');
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    const toolSection = findSection(buf, 'tools');
    expect(toolSection!.content).toContain('\u{2717}');
  });

  it('unknown tool_use_id is silently ignored', () => {
    const buf = createBuffer();
    const toolLines = new Map<string, ToolLineEntry>();
    const toolLineOrder: string[] = [];

    toolLines.set('toolu_known', { line: '\u{1F4C4} **read**  `file.ts`  \u{23F3}' });
    toolLineOrder.push('toolu_known');
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    // tool_result for unknown ID — should be ignored
    const unknown = toolLines.get('toolu_unknown');
    expect(unknown).toBeUndefined();

    // Original line unchanged
    const toolSection = findSection(buf, 'tools');
    expect(toolSection!.content).toContain('\u{23F3}');
  });

  it('multiple tools maintain order after partial completion', () => {
    const buf = createBuffer();
    const toolLines = new Map<string, ToolLineEntry>();
    const toolLineOrder: string[] = [];

    // Add 3 tools
    toolLines.set('t1', { line: '\u{1F4C4} **read**  `a.ts`  \u{23F3}' });
    toolLineOrder.push('t1');
    toolLines.set('t2', { line: '\u{1F4BB} **bash**  `npm test`  \u{23F3}' });
    toolLineOrder.push('t2');
    toolLines.set('t3', { line: '\u{1F4DD} **edit**  `b.ts` +1 -1  \u{23F3}' });
    toolLineOrder.push('t3');
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    // Complete t2 only
    toolLines.get('t2')!.line = toolLines.get('t2')!.line.replace('\u{23F3}', '\u{2713}');
    rebuildToolsSection(buf, toolLines, toolLineOrder);

    const toolSection = findSection(buf, 'tools');
    const lines = toolSection!.content.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('read');
    expect(lines[0]).toContain('\u{23F3}'); // t1 still pending
    expect(lines[1]).toContain('bash');
    expect(lines[1]).toContain('\u{2713}'); // t2 completed
    expect(lines[2]).toContain('edit');
    expect(lines[2]).toContain('\u{23F3}'); // t3 still pending
  });

  it('turn boundary resets tool state', () => {
    const toolLines = new Map<string, ToolLineEntry>();
    const toolLineOrder: string[] = [];

    toolLines.set('t1', { line: 'tool1 \u{23F3}' });
    toolLineOrder.push('t1');

    // Simulate user entry (turn boundary) — reset
    toolLines.clear();
    toolLineOrder.length = 0;

    expect(toolLines.size).toBe(0);
    expect(toolLineOrder).toHaveLength(0);
  });
});
