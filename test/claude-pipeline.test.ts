/**
 * End-to-end pipeline test: Claude JSONL → Universal TranscriptEntry
 *
 * Tests the full pipeline: read raw JSONL from disk → adapt via
 * adaptClaudeEntry → verify output matches universal TranscriptEntry contract.
 *
 * Fixtures are organized by Claude Code app version (which serves as the
 * de facto schema version). Each version directory contains a sample.jsonl
 * copied from a real transcript.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { adaptClaudeEntry, adaptClaudeEntries } from '../src/core/adapters/claude/claude-entry-adapter.js';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ============================================================================
// Helpers
// ============================================================================

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'claude');

/** Parse a JSONL file into raw (untyped) JSON objects — no casting. */
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

/** Get all version directories that have a sample.jsonl fixture. */
function getFixtureVersions(): string[] {
  return fs.readdirSync(FIXTURES_DIR)
    .filter((name) => {
      const samplePath = path.join(FIXTURES_DIR, name, 'sample.jsonl');
      return fs.existsSync(samplePath);
    })
    .sort();
}

/** Load raw entries for a version fixture. */
function loadFixture(version: string): Record<string, unknown>[] {
  return parseRawJsonl(path.join(FIXTURES_DIR, version, 'sample.jsonl'));
}

// ============================================================================
// Universal TranscriptEntry contract assertions
// ============================================================================

/** Assert that an adapted entry satisfies the universal TranscriptEntry contract. */
function assertUniversalContract(entry: TranscriptEntry, label: string): void {
  // Must have a type
  expect(entry.type, `${label}: type must be a string`).toBeTypeOf('string');
  expect(entry.type.length, `${label}: type must not be empty`).toBeGreaterThan(0);

  // Must have vendor: 'claude'
  expect(entry.vendor, `${label}: vendor must be 'claude'`).toBe('claude');

  // If message exists, it must have content
  if (entry.message) {
    expect(entry.message.content, `${label}: message.content must exist`).toBeDefined();
  }

  // uuid and timestamp should be strings if present
  if (entry.uuid !== undefined) {
    expect(entry.uuid, `${label}: uuid must be string`).toBeTypeOf('string');
  }
  if (entry.timestamp !== undefined) {
    expect(entry.timestamp, `${label}: timestamp must be string`).toBeTypeOf('string');
  }

  // isSidechain must be boolean if present
  if (entry.isSidechain !== undefined) {
    expect(entry.isSidechain, `${label}: isSidechain must be boolean`).toBeTypeOf('boolean');
  }

  // isMeta must be boolean if present
  if (entry.isMeta !== undefined) {
    expect(entry.isMeta, `${label}: isMeta must be boolean`).toBeTypeOf('boolean');
  }

  // metadata must be an object if present (overflow bag)
  if (entry.metadata !== undefined) {
    expect(entry.metadata, `${label}: metadata must be object`).toBeTypeOf('object');
  }
}

// ============================================================================
// Tests: Per-version pipeline
// ============================================================================

const versions = getFixtureVersions();

describe('Claude JSONL → TranscriptEntry pipeline', () => {
  // Sanity check: we have fixtures
  it('has at least one version fixture', () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  describe.each(versions)('version %s', (version) => {
    const rawEntries = loadFixture(version);
    const adapted = adaptClaudeEntries(rawEntries);

    it('parses raw JSONL without errors', () => {
      expect(rawEntries.length).toBeGreaterThan(0);
    });

    it('produces at least one adapted entry', () => {
      expect(adapted.length).toBeGreaterThan(0);
    });

    it('filters out queue-operation entries', () => {
      const queueOps = rawEntries.filter((e) => e.type === 'queue-operation');
      const adaptedQueueOps = adapted.filter((e) => e.type === 'queue-operation');
      // If raw had queue-ops, adapted should not
      if (queueOps.length > 0) {
        expect(adaptedQueueOps.length).toBe(0);
      }
    });

    it('every adapted entry satisfies universal TranscriptEntry contract', () => {
      for (let i = 0; i < adapted.length; i++) {
        assertUniversalContract(adapted[i], `entry[${i}] (type=${adapted[i].type})`);
      }
    });

    it('preserves version in metadata overflow', () => {
      // The raw `version` field is not a universal field, so it should
      // end up in the metadata bag
      const rawWithVersion = rawEntries.filter((e) => typeof e.version === 'string');
      if (rawWithVersion.length > 0) {
        const adaptedWithMeta = adapted.filter((e) => e.metadata?.version);
        expect(adaptedWithMeta.length).toBeGreaterThan(0);
        // Verify the version matches what we expect
        expect(adaptedWithMeta[0].metadata!.version).toBe(version);
      }
    });

    it('all user/assistant entries have message content', () => {
      const messages = adapted.filter(
        (e) => e.type === 'user' || e.type === 'assistant'
      );
      for (const msg of messages) {
        expect(msg.message, `${msg.type} entry must have message`).toBeDefined();
        expect(msg.message!.content, `${msg.type} entry must have content`).toBeDefined();
      }
    });

    it('preserves sessionId across entries', () => {
      const sessionIds = adapted
        .map((e) => e.sessionId)
        .filter((id) => id !== undefined);
      if (sessionIds.length > 1) {
        // All entries in a single file should share the same sessionId
        const unique = [...new Set(sessionIds)];
        expect(unique.length).toBe(1);
      }
    });

    it('preserves parent-child uuid chain', () => {
      // First entry should have parentUuid null
      const firstNonFiltered = adapted[0];
      if (firstNonFiltered) {
        expect(firstNonFiltered.parentUuid).toBeNull();
      }
      // Subsequent entries should reference a previous uuid as parentUuid
      const uuids = new Set(adapted.map((e) => e.uuid).filter(Boolean));
      for (let i = 1; i < adapted.length; i++) {
        const entry = adapted[i];
        if (entry.parentUuid) {
          expect(
            uuids.has(entry.parentUuid),
            `entry[${i}] parentUuid "${entry.parentUuid}" should reference an existing uuid`
          ).toBe(true);
        }
      }
    });
  });
});

// ============================================================================
// Tests: Adapter edge cases
// ============================================================================

describe('adaptClaudeEntry edge cases', () => {
  it('returns null for queue-operation', () => {
    const raw = { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-01-01' };
    expect(adaptClaudeEntry(raw)).toBeNull();
  });

  it('returns null for malformed entry (no type)', () => {
    const raw = { uuid: 'abc', message: { content: 'hello' } };
    expect(adaptClaudeEntry(raw)).toBeNull();
  });

  it('returns null for entry with non-string type', () => {
    const raw = { type: 123 };
    expect(adaptClaudeEntry(raw)).toBeNull();
  });

  it('injects vendor: claude on all adapted entries', () => {
    const raw = { type: 'user', uuid: 'abc', message: { role: 'user', content: 'hi' } };
    const result = adaptClaudeEntry(raw);
    expect(result).not.toBeNull();
    expect(result!.vendor).toBe('claude');
  });

  it('maps sourceToolAssistantUUID to sourceToolAssistantUuid', () => {
    const raw = {
      type: 'user',
      uuid: 'abc',
      sourceToolAssistantUUID: 'def-uuid',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    };
    const result = adaptClaudeEntry(raw);
    expect(result!.sourceToolAssistantUuid).toBe('def-uuid');
  });

  it('moves unknown fields to metadata overflow', () => {
    const raw = {
      type: 'user',
      uuid: 'abc',
      version: '2.1.37',
      gitBranch: 'main',
      userType: 'external',
      permissionMode: 'default',
      message: { role: 'user', content: 'test' },
    };
    const result = adaptClaudeEntry(raw);
    expect(result!.metadata).toBeDefined();
    expect(result!.metadata!.version).toBe('2.1.37');
    expect(result!.metadata!.gitBranch).toBe('main');
    expect(result!.metadata!.userType).toBe('external');
    expect(result!.metadata!.permissionMode).toBe('default');
  });

  it('preserves toolUseResult on user entries', () => {
    const raw = {
      type: 'user',
      uuid: 'abc',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
      toolUseResult: { stdout: 'hello', stderr: '', interrupted: false },
    };
    const result = adaptClaudeEntry(raw);
    expect(result!.toolUseResult).toBeDefined();
    expect((result!.toolUseResult as Record<string, unknown>).stdout).toBe('hello');
  });

  it('preserves isSidechain boolean', () => {
    const raw = {
      type: 'user',
      uuid: 'abc',
      isSidechain: true,
      agentId: 'a123',
      message: { role: 'user', content: 'warmup' },
    };
    const result = adaptClaudeEntry(raw);
    expect(result!.isSidechain).toBe(true);
    expect(result!.agentId).toBe('a123');
  });

  it('handles progress entry with tool content', () => {
    const raw = {
      type: 'progress',
      uuid: 'prog-1',
      parentUuid: 'parent-1',
      sessionId: 'sess-1',
      timestamp: '2026-01-01',
      parentToolUseID: 'tool-1',
      data: {
        agentId: 'a456',
        message: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
      },
    };
    const result = adaptClaudeEntry(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.vendor).toBe('claude');
    expect(result!.agentId).toBe('a456');
    expect(result!.parentToolUseID).toBe('tool-1');
    expect(result!.message).toBeDefined();
  });

  it('returns null for progress entry without tool content', () => {
    const raw = {
      type: 'progress',
      uuid: 'prog-2',
      data: {
        message: {
          type: 'assistant',
          message: {}, // no content
        },
      },
    };
    expect(adaptClaudeEntry(raw)).toBeNull();
  });

  it('prefers camelCase sessionId over snake_case session_id', () => {
    const raw = {
      type: 'user',
      uuid: 'abc',
      sessionId: 'camel-id',
      session_id: 'snake-id',
      message: { role: 'user', content: 'test' },
    };
    const result = adaptClaudeEntry(raw);
    expect(result!.sessionId).toBe('camel-id');
  });

  it('falls back to snake_case session_id when camelCase is absent', () => {
    const raw = {
      type: 'user',
      uuid: 'abc',
      session_id: 'snake-id',
      message: { role: 'user', content: 'test' },
    };
    const result = adaptClaudeEntry(raw);
    expect(result!.sessionId).toBe('snake-id');
  });
});

// ============================================================================
// Tests: No data loss
// ============================================================================

describe('no data loss through pipeline', () => {
  it.each(getFixtureVersions())('version %s: every raw field is preserved somewhere', (version) => {
    const rawEntries = loadFixture(version);

    for (const raw of rawEntries) {
      const adapted = adaptClaudeEntry(raw);
      if (!adapted) continue; // filtered entries are expected

      // Every raw field must appear either as a universal field or in metadata
      for (const key of Object.keys(raw)) {
        // These fields are explicitly destructured and mapped
        const universalFields = [
          'type', 'uuid', 'parentUuid', 'sessionId', 'session_id',
          'timestamp', 'isSidechain', 'isMeta', 'agentId', 'cwd',
          'message', 'toolUseResult', 'summary', 'leafUuid',
          'customTitle', 'sourceToolAssistantUUID', 'parent_tool_use_id',
          'parentToolUseID',
        ];

        if (universalFields.includes(key)) {
          // Mapped to a universal field (possibly renamed)
          continue;
        }

        // Everything else must be in metadata
        expect(
          adapted.metadata,
          `version ${version}: field "${key}" from raw entry should be in metadata`
        ).toBeDefined();
        expect(
          key in adapted.metadata!,
          `version ${version}: metadata should contain "${key}"`
        ).toBe(true);
      }
    }
  });
});
