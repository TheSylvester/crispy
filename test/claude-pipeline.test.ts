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
import * as path from 'path';
import * as os from 'os';
import { adaptClaudeEntry, adaptClaudeEntries } from '../src/core/adapters/claude/claude-entry-adapter.js';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ============================================================================
// Setup — auto-discover fixture when env vars aren't set
// ============================================================================

/**
 * Extract the Claude Code version from the first entry that has one.
 * Reads only the first 8KB for speed.
 */
function extractVersion(filepath: string): string | undefined {
  try {
    const head = fs.readFileSync(filepath, { encoding: 'utf-8', flag: 'r' }).slice(0, 8192);
    const match = head.match(/"version":"([^"]+)"/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Score a transcript by how many distinct features it covers. */
function scoreFile(filepath: string): number {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    let score = 0;
    // Entry types (1pt each)
    if (content.includes('"type":"user"'))                  score++;
    if (content.includes('"type":"assistant"'))             score++;
    if (content.includes('"type":"system"'))                score++;
    if (content.includes('"type":"summary"'))               score++;
    if (content.includes('"type":"result"'))                score++;
    if (content.includes('"type":"progress"'))              score++;
    if (content.includes('"type":"file-history-snapshot"')) score++;
    // Content block types (2pt each)
    if (content.includes('"type":"tool_use"'))    score += 2;
    if (content.includes('"type":"tool_result"')) score += 2;
    if (content.includes('"type":"thinking"'))    score += 2;
    // Structural features
    if (content.includes('"toolUseResult"'))    score += 2;
    if (content.includes('"isSidechain":true')) score += 2;
    if (content.includes('"usage":'))           score++;
    return score;
  } catch {
    return 0;
  }
}

/**
 * Walk ~/.claude/projects/ to find the richest transcript under 512KB.
 * Returns { file, version } or undefined.
 */
function discoverFixture(): { file: string; version: string } | undefined {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return undefined;

  const SIZE_CAP = 524288;
  let bestFile: string | undefined;
  let bestScore = 0;
  let bestVersion: string | undefined;
  let candidates = 0;

  // Walk project directories, collect .jsonl files sorted by mtime desc
  const allFiles: { path: string; mtime: number }[] = [];
  for (const slug of fs.readdirSync(projectsDir)) {
    const projDir = path.join(projectsDir, slug);
    let stat: fs.Stats;
    try { stat = fs.statSync(projDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    for (const file of fs.readdirSync(projDir)) {
      if (!file.endsWith('.jsonl')) continue;
      // Skip sub-agent transcripts — they legitimately contain mixed sessionIds
      // (parent session ID on first entry, sub-agent's own ID on the rest)
      if (file.startsWith('agent-')) continue;
      const fp = path.join(projDir, file);
      try {
        const s = fs.statSync(fp);
        if (s.size > 1024 && s.size < SIZE_CAP) {
          allFiles.push({ path: fp, mtime: s.mtimeMs });
        }
      } catch { /* skip */ }
    }
  }

  // Sort newest first, sample top 30
  allFiles.sort((a, b) => b.mtime - a.mtime);
  for (const entry of allFiles.slice(0, 30)) {
    const v = extractVersion(entry.path);
    if (!v) continue;
    candidates++;
    const s = scoreFile(entry.path);
    if (s > bestScore) {
      bestFile = entry.path;
      bestScore = s;
      bestVersion = v;
    }
  }

  if (bestFile && bestVersion) return { file: bestFile, version: bestVersion };
  return undefined;
}

// Use env vars if set (from check-claude-fixture.sh), otherwise auto-discover
let FIXTURE_FILE = process.env.CLAUDE_FIXTURE_FILE;
let FIXTURE_VERSION: string | undefined = process.env.CLAUDE_FIXTURE_VERSION;

if (!FIXTURE_FILE) {
  const discovered = discoverFixture();
  if (discovered) {
    FIXTURE_FILE = discovered.file;
    FIXTURE_VERSION = discovered.version;
  }
}

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
    throw new Error(
      'No Claude transcript fixture found. Ensure ~/.claude/projects/ contains .jsonl files, ' +
      'or set CLAUDE_FIXTURE_FILE and CLAUDE_FIXTURE_VERSION env vars.',
    );
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
    // Filter out sidechain entries (sub-agent) which legitimately carry different sessionIds.
    // Forked/resumed transcripts may also contain a parent sessionId on older entries,
    // so we check that there is one dominant sessionId (the most common one).
    const mainEntries = adapted.filter((e) => !e.isSidechain);
    const ids = [...new Set(mainEntries.map((e) => e.sessionId).filter(Boolean))];
    if (ids.length > 1) {
      // Find the most common sessionId — it should represent the vast majority
      const counts = new Map<string, number>();
      for (const e of mainEntries) {
        if (e.sessionId) counts.set(e.sessionId, (counts.get(e.sessionId) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const dominantCount = sorted[0][1];
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      // The dominant sessionId should cover at least 50% of entries
      expect(dominantCount / total).toBeGreaterThanOrEqual(0.5);
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
