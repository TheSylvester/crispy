/**
 * End-to-end pipeline test: Claude JSONL → Universal TranscriptEntry
 *
 * Requires CLAUDE_FIXTURE_FILE and CLAUDE_FIXTURE_VERSION env vars,
 * set by scripts/check-claude-fixture.sh which finds the richest
 * transcript for the current Claude Code version.
 *
 * Run via: npm test (which calls the script)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { adaptClaudeEntry, adaptClaudeEntries } from '../src/core/adapters/claude/claude-entry-adapter.js';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ============================================================================
// Setup
// ============================================================================

const FIXTURE_FILE = process.env.CLAUDE_FIXTURE_FILE;
const FIXTURE_VERSION = process.env.CLAUDE_FIXTURE_VERSION;

function parseRawJsonl(filepath: string): Record<string, unknown>[] {
  const content = fs.readFileSync(filepath, 'utf-8');
  const entries: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function assertUniversalContract(entry: TranscriptEntry, label: string): void {
  expect(entry.type, `${label}: type must be a string`).toBeTypeOf('string');
  expect(entry.type.length, `${label}: type must not be empty`).toBeGreaterThan(0);
  expect(entry.vendor, `${label}: vendor must be 'claude'`).toBe('claude');

  if (entry.message) {
    expect(entry.message.content, `${label}: message.content must exist`).toBeDefined();
  }
  if (entry.uuid !== undefined) {
    expect(entry.uuid, `${label}: uuid must be string`).toBeTypeOf('string');
  }
  if (entry.timestamp !== undefined) {
    expect(entry.timestamp, `${label}: timestamp must be string`).toBeTypeOf('string');
  }
  if (entry.isSidechain !== undefined) {
    expect(entry.isSidechain, `${label}: isSidechain must be boolean`).toBeTypeOf('boolean');
  }
  if (entry.isMeta !== undefined) {
    expect(entry.isMeta, `${label}: isMeta must be boolean`).toBeTypeOf('boolean');
  }
  if (entry.metadata !== undefined) {
    expect(entry.metadata, `${label}: metadata must be object`).toBeTypeOf('object');
  }
}

// Fields the adapter explicitly destructures and maps to universal fields
const UNIVERSAL_FIELDS = [
  'type', 'uuid', 'parentUuid', 'sessionId', 'session_id',
  'timestamp', 'isSidechain', 'isMeta', 'agentId', 'cwd',
  'message', 'toolUseResult', 'summary', 'leafUuid',
  'customTitle', 'sourceToolAssistantUUID', 'parent_tool_use_id',
  'parentToolUseID',
];

// ============================================================================
// Pipeline tests against real transcript
// ============================================================================

describe(`Claude JSONL pipeline (v${FIXTURE_VERSION})`, () => {
  if (!FIXTURE_FILE || !fs.existsSync(FIXTURE_FILE)) {
    it.skip('no fixture file — run via: npm test', () => {});
    return;
  }

  const rawEntries = parseRawJsonl(FIXTURE_FILE);
  const adapted = adaptClaudeEntries(rawEntries);

  it('parses raw JSONL', () => {
    expect(rawEntries.length).toBeGreaterThan(0);
  });

  it('produces adapted entries', () => {
    expect(adapted.length).toBeGreaterThan(0);
  });

  it('filters out queue-operation entries', () => {
    const rawQueueOps = rawEntries.filter((e) => e.type === 'queue-operation').length;
    const adaptedQueueOps = adapted.filter((e) => e.type === 'queue-operation').length;
    if (rawQueueOps > 0) {
      expect(adaptedQueueOps).toBe(0);
    }
  });

  it('every entry satisfies universal TranscriptEntry contract', () => {
    for (let i = 0; i < adapted.length; i++) {
      assertUniversalContract(adapted[i], `entry[${i}] (type=${adapted[i].type})`);
    }
  });

  it('preserves version in metadata', () => {
    const withVersion = adapted.filter((e) => e.metadata?.version);
    if (withVersion.length > 0) {
      expect(withVersion[0].metadata!.version).toBe(FIXTURE_VERSION);
    }
  });

  it('all user/assistant entries have message content', () => {
    for (const entry of adapted) {
      if (entry.type === 'user' || entry.type === 'assistant') {
        expect(entry.message, `${entry.type} must have message`).toBeDefined();
        expect(entry.message!.content, `${entry.type} must have content`).toBeDefined();
      }
    }
  });

  it('consistent sessionId across entries', () => {
    const ids = [...new Set(adapted.map((e) => e.sessionId).filter(Boolean))];
    if (ids.length > 0) {
      expect(ids.length).toBe(1);
    }
  });

  it('no data loss: every raw field preserved', () => {
    for (const raw of rawEntries) {
      const entry = adaptClaudeEntry(raw);
      if (!entry) continue;

      for (const key of Object.keys(raw)) {
        if (UNIVERSAL_FIELDS.includes(key)) continue;
        expect(entry.metadata, `field "${key}" should be in metadata`).toBeDefined();
        expect(key in entry.metadata!, `metadata should contain "${key}"`).toBe(true);
      }
    }
  });

  it('coverage report', () => {
    const types = [...new Set(adapted.map((e) => e.type))].sort();
    const has = (fn: (e: TranscriptEntry) => boolean) => adapted.some(fn);

    const features = [
      has((e) => Array.isArray(e.message?.content) && (e.message!.content as { type: string }[]).some((b) => b.type === 'tool_use')) && 'tool_use',
      has((e) => Array.isArray(e.message?.content) && (e.message!.content as { type: string }[]).some((b) => b.type === 'tool_result')) && 'tool_result',
      has((e) => Array.isArray(e.message?.content) && (e.message!.content as { type: string }[]).some((b) => b.type === 'thinking')) && 'thinking',
      has((e) => e.isSidechain === true) && 'isSidechain',
      has((e) => e.toolUseResult !== undefined) && 'toolUseResult',
      has((e) => e.message !== undefined && 'usage' in e.message) && 'usage',
    ].filter(Boolean);

    console.log(`  types:    [${types.join(', ')}]`);
    console.log(`  features: [${features.join(', ')}]`);
    expect(true).toBe(true);
  });
});

// ============================================================================
// Adapter edge cases (synthetic, always run)
// ============================================================================

describe('adaptClaudeEntry edge cases', () => {
  it('returns null for queue-operation', () => {
    expect(adaptClaudeEntry({ type: 'queue-operation', operation: 'dequeue' })).toBeNull();
  });

  it('returns null for no type', () => {
    expect(adaptClaudeEntry({ uuid: 'abc' })).toBeNull();
  });

  it('returns null for non-string type', () => {
    expect(adaptClaudeEntry({ type: 123 })).toBeNull();
  });

  it('injects vendor: claude', () => {
    const r = adaptClaudeEntry({ type: 'user', uuid: 'a', message: { role: 'user', content: 'hi' } });
    expect(r!.vendor).toBe('claude');
  });

  it('maps sourceToolAssistantUUID → sourceToolAssistantUuid', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a', sourceToolAssistantUUID: 'x',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'ok' }] },
    });
    expect(r!.sourceToolAssistantUuid).toBe('x');
  });

  it('unknown fields → metadata', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a', version: '2.1.37', gitBranch: 'main',
      message: { role: 'user', content: 'test' },
    });
    expect(r!.metadata!.version).toBe('2.1.37');
    expect(r!.metadata!.gitBranch).toBe('main');
  });

  it('preserves toolUseResult', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
      toolUseResult: { stdout: 'hello' },
    });
    expect((r!.toolUseResult as Record<string, unknown>).stdout).toBe('hello');
  });

  it('preserves isSidechain + agentId', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a', isSidechain: true, agentId: 'a1',
      message: { role: 'user', content: 'warmup' },
    });
    expect(r!.isSidechain).toBe(true);
    expect(r!.agentId).toBe('a1');
  });

  it('unwraps progress with tool content', () => {
    const r = adaptClaudeEntry({
      type: 'progress', uuid: 'p1', parentToolUseID: 't1',
      data: {
        agentId: 'a2',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
        },
      },
    });
    expect(r!.type).toBe('assistant');
    expect(r!.agentId).toBe('a2');
    expect(r!.parentToolUseID).toBe('t1');
  });

  it('returns null for progress without content', () => {
    expect(adaptClaudeEntry({
      type: 'progress', data: { message: { type: 'assistant', message: {} } },
    })).toBeNull();
  });

  it('prefers camelCase sessionId', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a', sessionId: 'camel', session_id: 'snake',
      message: { role: 'user', content: 'test' },
    });
    expect(r!.sessionId).toBe('camel');
  });

  it('falls back to snake_case session_id', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a', session_id: 'snake',
      message: { role: 'user', content: 'test' },
    });
    expect(r!.sessionId).toBe('snake');
  });

  it('preserves customTitle', () => {
    const r = adaptClaudeEntry({ type: 'custom-title', customTitle: 'My Session' });
    expect(r!.customTitle).toBe('My Session');
  });

  it('preserves isMeta', () => {
    const r = adaptClaudeEntry({
      type: 'user', uuid: 'a', isMeta: true,
      message: { role: 'user', content: 'init' },
    });
    expect(r!.isMeta).toBe(true);
  });
});
