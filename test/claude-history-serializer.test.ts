/**
 * Tests for the Claude History Serializer (reverse adapter).
 *
 * Validates that serializeToClaudeJsonl() correctly converts universal
 * TranscriptEntry[] into valid Claude Code JSONL format, including:
 * - UUID chain (parentUuid linking)
 * - Thinking block stripping
 * - Tool use / tool result serialization
 * - Content normalization (string → text block array)
 * - Edge cases (empty history, result entries)
 */

import { describe, it, expect } from 'vitest';
import {
  serializeToClaudeJsonl,
  cwdToProjectSlug,
} from '../src/core/adapters/claude/claude-history-serializer.js';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse all lines from a JSONL string, returning parsed objects. */
function parseJsonl(jsonl: string): Record<string, unknown>[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Build a minimal user entry. */
function makeUserEntry(text: string, overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    ...overrides,
  };
}

/** Build a minimal assistant entry. */
function makeAssistantEntry(
  text: string,
  overrides?: Partial<TranscriptEntry>,
): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    ...overrides,
  };
}

const CWD = '/home/user/project';
const SESSION_ID = 'test-session-id';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cwdToProjectSlug', () => {
  it('replaces slashes with dashes', () => {
    expect(cwdToProjectSlug('/home/user/projects/my-app')).toBe(
      '-home-user-projects-my-app',
    );
  });

  it('handles single-level path', () => {
    expect(cwdToProjectSlug('/tmp')).toBe('-tmp');
  });

  it('replaces Windows backslashes with dashes', () => {
    expect(cwdToProjectSlug('C:\\Users\\user\\projects\\my-app')).toBe(
      'C--Users-user-projects-my-app',
    );
  });

  it('handles mixed separators (Windows + Unix)', () => {
    expect(cwdToProjectSlug('C:\\Users\\user/projects/my-app')).toBe(
      'C--Users-user-projects-my-app',
    );
  });
});

describe('serializeToClaudeJsonl', () => {
  it('returns empty string for empty history', () => {
    expect(serializeToClaudeJsonl([], SESSION_ID, CWD)).toBe('');
  });

  it('produces parseable JSONL (each line is valid JSON)', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('hello'),
      makeAssistantEntry('world'),
    ];

    const jsonl = serializeToClaudeJsonl(entries, SESSION_ID, CWD);
    const lines = jsonl.split('\n').filter((l) => l.trim());

    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('serializes user entry with correct structure', () => {
    const entries: TranscriptEntry[] = [makeUserEntry('test prompt')];
    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));

    expect(lines.length).toBe(1);
    const line = lines[0];

    expect(line.type).toBe('user');
    expect(line.sessionId).toBe(SESSION_ID);
    expect(line.cwd).toBe(CWD);
    expect(line.isSidechain).toBe(false);
    expect(line.userType).toBe('external');
    expect(line.version).toBe('2.1.58');
    expect(line.gitBranch).toBe('main');

    const msg = line.message as Record<string, unknown>;
    expect(msg.role).toBe('user');
    expect(msg.content).toEqual([{ type: 'text', text: 'test prompt' }]);
  });

  it('serializes assistant entry with correct structure', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('hi'),
      makeAssistantEntry('hello back'),
    ];
    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));

    const assistant = lines[1];
    expect(assistant.type).toBe('assistant');
    expect(assistant.requestId).toBe('req_synthetic_001');

    const msg = assistant.message as Record<string, unknown>;
    expect(msg.role).toBe('assistant');
    expect(msg.type).toBe('message');
    expect((msg as Record<string, unknown>).stop_reason).toBe('end_turn');
    expect((msg as Record<string, unknown>).stop_sequence).toBeNull();
    expect(msg.id).toBe('msg_synthetic_001');
    expect(msg.usage).toBeDefined();
  });

  it('chains parentUuid correctly (null → uuid1 → uuid2 → ...)', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('first'),
      makeAssistantEntry('second'),
      makeUserEntry('third'),
    ];
    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));

    expect(lines.length).toBe(3);

    // First entry: parentUuid is null
    expect(lines[0].parentUuid).toBeNull();

    // Second entry: parentUuid matches first entry's uuid
    expect(lines[1].parentUuid).toBe(lines[0].uuid);

    // Third entry: parentUuid matches second entry's uuid
    expect(lines[2].parentUuid).toBe(lines[1].uuid);

    // All uuids are unique
    const uuids = lines.map((l) => l.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('stamps sessionId on every entry', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('a'),
      makeAssistantEntry('b'),
      makeUserEntry('c'),
    ];
    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));

    for (const line of lines) {
      expect(line.sessionId).toBe(SESSION_ID);
    }
  });

  it('strips thinking blocks from assistant entries', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('think about this'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me reason...',
              signature: 'EuYECkYICxgCKkD+qqJ2gKAy...',
            },
            { type: 'text', text: 'Here is my answer' },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const assistant = lines[1];
    const msg = assistant.message as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>>;

    // Only text block remains — thinking block is stripped
    expect(content.length).toBe(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Here is my answer');
  });

  it('serializes tool_use blocks in assistant entries', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('read file'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that.' },
            {
              type: 'tool_use',
              id: 'toolu_01abc',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const assistant = lines[1];
    const msg = assistant.message as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>>;

    expect(content.length).toBe(2);
    expect(content[1].type).toBe('tool_use');
    expect(content[1].id).toBe('toolu_01abc');
    expect(content[1].name).toBe('Read');

    // stop_reason should be "tool_use" since last block is tool_use
    expect(msg.stop_reason).toBe('tool_use');
  });

  it('serializes tool_result user entries', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('read file'),
      makeAssistantEntry('reading...'),
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01abc',
              content: 'file contents here',
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(3);

    const toolResult = lines[2];
    expect(toolResult.type).toBe('user');
    const msg = toolResult.message as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_result');
    expect(content[0].tool_use_id).toBe('toolu_01abc');
  });

  it('handles string content by wrapping in text block', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: 'plain string content',
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const msg = lines[0].message as Record<string, unknown>;
    expect(msg.content).toEqual([{ type: 'text', text: 'plain string content' }]);
  });

  it('serializes result entries as user entries with tool_result content', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('do something'),
      makeAssistantEntry('done'),
      {
        type: 'result',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01xyz',
              content: 'result data',
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(3);

    const result = lines[2];
    expect(result.type).toBe('user');
    const msg = result.message as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_result');
  });

  it('skips sidechain entries', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('main thread'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        isSidechain: true,
        agentId: 'abc123',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'sub-agent response' }],
        },
      },
      makeAssistantEntry('back to main'),
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(2); // sidechain entry skipped
  });

  it('skips system, summary, progress, and queue-operation entries', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('hello'),
      { type: 'system', timestamp: '2026-01-01T00:00:01.000Z' } as TranscriptEntry,
      { type: 'summary', summary: 'test', timestamp: '2026-01-01T00:00:01.000Z' } as TranscriptEntry,
      { type: 'progress', timestamp: '2026-01-01T00:00:01.000Z' } as TranscriptEntry,
      { type: 'queue-operation', timestamp: '2026-01-01T00:00:01.000Z' } as TranscriptEntry,
      makeAssistantEntry('world'),
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(2); // only user + assistant
  });

  it('skips entries without message content', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('hello'),
      { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z' } as TranscriptEntry,
      makeAssistantEntry('world'),
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(2); // message-less assistant skipped
  });

  it('preserves image blocks in content', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const msg = lines[0].message as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>>;

    expect(content.length).toBe(2);
    expect(content[1].type).toBe('image');
    const source = content[1].source as Record<string, unknown>;
    expect(source.type).toBe('base64');
    expect(source.data).toBe('iVBORw0KGgo=');
  });

  it('uses entry model when available for assistant entries', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('hi'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-3-5-haiku-20241022',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const msg = lines[1].message as Record<string, unknown>;
    expect(msg.model).toBe('claude-3-5-haiku-20241022');
  });

  it('increments assistant requestId and message id', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('first'),
      makeAssistantEntry('response 1'),
      makeUserEntry('second'),
      makeAssistantEntry('response 2'),
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));

    expect(lines[1].requestId).toBe('req_synthetic_001');
    expect(lines[3].requestId).toBe('req_synthetic_002');

    const msg1 = lines[1].message as Record<string, unknown>;
    const msg3 = lines[3].message as Record<string, unknown>;
    expect(msg1.id).toBe('msg_synthetic_001');
    expect(msg3.id).toBe('msg_synthetic_002');
  });

  it('handles tool_use without matching tool_result gracefully', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('run something'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_orphan',
              name: 'Bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      },
      // No tool_result follows — still serialized fine
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(2);

    const msg = lines[1].message as Record<string, unknown>;
    expect(msg.stop_reason).toBe('tool_use');
  });

  it('ends JSONL with a trailing newline', () => {
    const entries: TranscriptEntry[] = [makeUserEntry('hello')];
    const jsonl = serializeToClaudeJsonl(entries, SESSION_ID, CWD);

    expect(jsonl.endsWith('\n')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Empty tool_result content sanitization (Claude API rejects empty content)
  // -------------------------------------------------------------------------

  it('fills fallback content for tool_result with is_error and empty string content', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('run command'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_err',
              name: 'Bash',
              input: { command: 'false' },
            },
          ],
        },
      },
      {
        type: 'result',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_err',
              content: '',
              is_error: true,
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(3);

    const resultMsg = lines[2].message as Record<string, unknown>;
    const content = resultMsg.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_result');
    expect(content[0].is_error).toBe(true);
    // Must NOT be empty — Claude API rejects empty content with is_error
    expect(content[0].content).toBe('(error)');
  });

  it('fills fallback content for tool_result with empty string and no error', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('run command'),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_ok',
              name: 'Bash',
              input: { command: 'true' },
            },
          ],
        },
      },
      {
        type: 'result',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ok',
              content: '',
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const resultMsg = lines[2].message as Record<string, unknown>;
    const content = resultMsg.content as Array<Record<string, unknown>>;
    expect(content[0].content).toBe('(no output)');
  });

  it('fills fallback content for user entries containing empty tool_results', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('run command'),
      makeAssistantEntry('done'),
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_user',
              content: '',
              is_error: true,
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    expect(lines.length).toBe(3);

    const resultMsg = lines[2].message as Record<string, unknown>;
    const content = resultMsg.content as Array<Record<string, unknown>>;
    expect(content[0].content).toBe('(error)');
  });

  it('does not modify tool_result blocks that already have content', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('run command'),
      makeAssistantEntry('done'),
      {
        type: 'result',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ok',
              content: 'actual output data',
              is_error: false,
            },
          ],
        },
      },
    ];

    const lines = parseJsonl(serializeToClaudeJsonl(entries, SESSION_ID, CWD));
    const resultMsg = lines[2].message as Record<string, unknown>;
    const content = resultMsg.content as Array<Record<string, unknown>>;
    expect(content[0].content).toBe('actual output data');
  });
});
