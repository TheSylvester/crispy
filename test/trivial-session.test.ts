/**
 * Tests for isTrivialSession() — detects warmup, empty, and interrupted
 * sessions that should be filtered from the session list.
 */

import { describe, it, expect } from 'vitest';
import { isTrivialSession } from '../src/core/adapters/claude/jsonl-reader.js';
import type { ClaudeTranscriptEntry } from '../src/core/adapters/claude/jsonl-reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(
  content: string | object[],
  opts?: Record<string, unknown>,
): ClaudeTranscriptEntry {
  return {
    type: 'user' as const,
    message: { role: 'user', content },
    ...opts,
  } as ClaudeTranscriptEntry;
}

function makeAssistant(
  content: string | object[],
  opts?: Record<string, unknown>,
): ClaudeTranscriptEntry {
  return {
    type: 'assistant' as const,
    message: { role: 'assistant', content },
    ...opts,
  } as ClaudeTranscriptEntry;
}

/** Tool-result user entry (machine-generated, not a human prompt). */
function makeToolResult(toolUseId: string): ClaudeTranscriptEntry {
  return {
    type: 'user' as const,
    toolUseResult: { agentId: 'test' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: 'Warmup' }],
    },
  } as ClaudeTranscriptEntry;
}

function makeEntry(
  type: string,
  extra?: Record<string, unknown>,
): ClaudeTranscriptEntry {
  return { type, ...extra } as ClaudeTranscriptEntry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isTrivialSession', () => {
  // -- Trivial cases --

  it('detects empty file (0 entries, 0 bytes)', () => {
    expect(isTrivialSession([], 0)).toBe(true);
  });

  it('detects queue-operation only session (small file)', () => {
    const entries = [makeEntry('queue-operation')];
    expect(isTrivialSession(entries, 200)).toBe(true);
  });

  it('detects file-history-snapshot only session', () => {
    const entries = [makeEntry('file-history-snapshot')];
    expect(isTrivialSession(entries, 500)).toBe(true);
  });

  it('detects system entries only session', () => {
    const entries = [makeEntry('system'), makeEntry('system')];
    expect(isTrivialSession(entries, 300)).toBe(true);
  });

  it('detects warmup with no response (string content)', () => {
    const entries = [makeUser('Warmup')];
    expect(isTrivialSession(entries, 100)).toBe(true);
  });

  it('detects warmup with assistant ack (string content)', () => {
    const entries = [
      makeUser('Warmup'),
      makeAssistant('Ready'),
    ];
    expect(isTrivialSession(entries, 200)).toBe(true);
  });

  it('detects warmup with array content blocks', () => {
    const entries = [
      makeUser([{ type: 'text', text: 'Warmup' }]),
      makeAssistant([{ type: 'text', text: 'Acknowledged' }]),
    ];
    expect(isTrivialSession(entries, 300)).toBe(true);
  });

  it('detects extended warmup with tool-use round-trips', () => {
    // Real pattern: Warmup → assistant tries tools → tool_results → final ack
    const entries = [
      makeUser('Warmup'),
      makeAssistant([{ type: 'text', text: 'Let me explore...' }]),
      makeAssistant([{ type: 'tool_use', id: 'tu1', name: 'Glob' }]),
      makeAssistant([{ type: 'tool_use', id: 'tu2', name: 'Read' }]),
      makeAssistant([{ type: 'tool_use', id: 'tu3', name: 'Grep' }]),
      makeToolResult('tu1'),
      makeToolResult('tu2'),
      makeToolResult('tu3'),
      makeAssistant([{ type: 'text', text: 'Ready, tools warmed up.' }]),
    ];
    expect(isTrivialSession(entries, 7000)).toBe(true);
  });

  it('detects interrupted session (user + interrupt, no assistant, 3 entries)', () => {
    const entries = [
      makeEntry('queue-operation'),
      makeUser('Help me refactor this'),
      makeUser('[Request interrupted by user]'),
    ];
    expect(isTrivialSession(entries, 400)).toBe(true);
  });

  it('detects interrupted session (2 entries, user only)', () => {
    const entries = [
      makeUser('Do something'),
      makeUser('[Request interrupted by user]'),
    ];
    expect(isTrivialSession(entries, 200)).toBe(true);
  });

  // -- Non-trivial cases --

  it('keeps unparseable file (0 entries, >0 bytes)', () => {
    expect(isTrivialSession([], 1024)).toBe(false);
  });

  it('keeps legitimate 1-turn session (user + assistant with real content)', () => {
    const entries = [
      makeUser('How do I sort an array in JavaScript?'),
      makeAssistant('You can use Array.prototype.sort()...'),
    ];
    expect(isTrivialSession(entries, 500)).toBe(false);
  });

  it('keeps warmup-labeled session reused with a second real user prompt', () => {
    const entries = [
      makeUser('Warmup'),
      makeAssistant('Ready'),
      makeUser('Now actually help me with something'),
    ];
    expect(isTrivialSession(entries, 600)).toBe(false);
  });

  it('keeps extended warmup reused with a follow-up real user prompt', () => {
    const entries = [
      makeUser('Warmup'),
      makeAssistant([{ type: 'tool_use', id: 'tu1', name: 'Glob' }]),
      makeToolResult('tu1'),
      makeAssistant([{ type: 'text', text: 'Ready' }]),
      makeUser('Now do real work'),  // Second real user prompt
      makeAssistant('On it...'),
    ];
    expect(isTrivialSession(entries, 5000)).toBe(false);
  });

  it('keeps multi-turn normal session', () => {
    const entries = [
      makeUser('Explain closures'),
      makeAssistant('A closure is a function that...'),
      makeUser('Can you give an example?'),
      makeAssistant('Sure, here is an example...'),
    ];
    expect(isTrivialSession(entries, 1000)).toBe(false);
  });

  it('keeps queue-op mixed with real user + assistant messages', () => {
    const entries = [
      makeEntry('queue-operation'),
      makeUser('What is TypeScript?'),
      makeAssistant('TypeScript is a typed superset of JavaScript...'),
    ];
    expect(isTrivialSession(entries, 800)).toBe(false);
  });

  it('keeps interrupted session with many entries (real conversation interrupted late)', () => {
    const entries = [
      makeEntry('queue-operation'),
      makeUser('Help me build an app'),
      makeAssistant('Sure, let me start...'),
      makeUser('Actually stop'),
      makeUser('[Request interrupted by user]'),
    ];
    // Has assistant response + many entries — not trivial
    expect(isTrivialSession(entries, 1200)).toBe(false);
  });

  it('skips isMeta entries when counting messages', () => {
    // A session where the only "user" entry is a meta entry — no real messages
    const entries = [makeUser('system context', { isMeta: true })];
    expect(isTrivialSession(entries, 150)).toBe(true);
  });

  // -- Large file guard (image attachment sessions) --

  it('keeps session when entries are incomplete due to large file (image attachment)', () => {
    // queue-operation only in entries, but file is 100KB — entries are truncated, not empty
    const entries = [makeEntry('queue-operation')];
    expect(isTrivialSession(entries, 100 * 1024)).toBe(false);
  });

  it('keeps session when only non-message entries but file exceeds 64KB', () => {
    const entries = [makeEntry('queue-operation'), makeEntry('file-history-snapshot')];
    expect(isTrivialSession(entries, 80 * 1024)).toBe(false);
  });
});
