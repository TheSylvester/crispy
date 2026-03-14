/**
 * Tests for Tracker Project Dedup — heuristic functions, candidate detection,
 * and DB merge operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { computeJaccard, normalizedLevenshtein, findDupeCandidates, parseVerdict, mergeProjects } from '../src/core/rosie/tracker/db-writer.js';
import { _setTestDir, dbPath } from '../src/core/activity-index.js';
import { getDb } from '../src/core/crispy-db.js';

// ============================================================================
// Heuristic helpers
// ============================================================================

describe('computeJaccard', () => {
  it('computes partial intersection correctly', () => {
    expect(computeJaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });

  it('handles edge cases', () => {
    expect(computeJaccard([], [])).toBe(0);
    expect(computeJaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(computeJaccard(['a'], ['b'])).toBe(0);
  });
});

describe('normalizedLevenshtein', () => {
  it('treats case and punctuation as irrelevant', () => {
    expect(normalizedLevenshtein('Fix: Rosie Tracker', 'fix rosie tracker')).toBe(0);
  });

  it('scores similar project titles below threshold', () => {
    const dist = normalizedLevenshtein(
      'Fix Rosie Tracker Hook Child Session Failures',
      'Fix Rosie tracker hook dispatch failures',
    );
    expect(dist).toBeLessThan(0.3); // would be flagged as candidate
  });

  it('scores unrelated titles above threshold', () => {
    const dist = normalizedLevenshtein(
      'Implement WebSocket reconnection',
      'Fix Rosie Tracker Hook Failures',
    );
    expect(dist).toBeGreaterThan(0.5);
  });
});

// ============================================================================
// Candidate detection
// ============================================================================

describe('findDupeCandidates', () => {
  const base = { stage: 'active', summary: null, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-08T00:00:00Z' };

  it('flags entity overlap, title similarity, or both', () => {
    const projects = [
      { ...base, id: '1', title: 'Unrelated Title X', entities: '["src/a.ts","src/b.ts","src/c.ts"]' },
      { ...base, id: '2', title: 'Unrelated Title Y', entities: '["src/a.ts","src/b.ts","src/d.ts"]' },     // entity overlap (Jaccard 0.5)
      { ...base, id: '3', title: 'Fix Rosie Tracker Hook Failures', entities: '["x.ts"]' },
      { ...base, id: '4', title: 'Fix Rosie Tracker Hook Errors', entities: '["y.ts"]' },                     // title similarity
    ];
    const result = findDupeCandidates(projects);
    expect(result).toHaveLength(2);
    expect(result.some((c) => c.reason.includes('entity-jaccard'))).toBe(true);
    expect(result.some((c) => c.reason.includes('title-levenshtein'))).toBe(true);
  });

  it('does not flag distinct projects', () => {
    const projects = [
      { ...base, id: '1', title: 'Implement WebSocket reconnection', entities: '["src/ws.ts"]' },
      { ...base, id: '2', title: 'Fix Rosie Tracker Hook Failures', entities: '["src/tracker.ts"]' },
    ];
    expect(findDupeCandidates(projects)).toHaveLength(0);
  });

  it('handles malformed entity JSON gracefully', () => {
    const projects = [
      { ...base, id: '1', title: 'Implement WebSocket reconnection', entities: 'not-json' },
      { ...base, id: '2', title: 'Fix Rosie Tracker Failures', entities: '["src/a.ts"]' },
    ];
    expect(findDupeCandidates(projects)).toEqual([]);
  });
});

// ============================================================================
// Verdict parsing
// ============================================================================

describe('parseVerdict', () => {
  const idA = 'aaaa-1111';
  const idB = 'bbbb-2222';

  it('parses MERGE with optional fields', () => {
    const text = `MERGE keep=${idA} remove=${idB}\ntitle=Better Title\nsummary=Combined`;
    expect(parseVerdict(text, idA, idB)).toEqual({
      keepId: idA, removeId: idB, mergedTitle: 'Better Title', mergedSummary: 'Combined',
    });
  });

  it('returns null for DISTINCT, empty, garbage, or invalid IDs', () => {
    expect(parseVerdict('DISTINCT', idA, idB)).toBeNull();
    expect(parseVerdict('', idA, idB)).toBeNull();
    expect(parseVerdict('I think these are the same', idA, idB)).toBeNull();
    expect(parseVerdict('MERGE keep=xxxx remove=yyyy', idA, idB)).toBeNull();
    expect(parseVerdict(`MERGE keep=${idA} remove=${idA}`, idA, idB)).toBeNull();
  });
});

// ============================================================================
// DB merge (integration)
// ============================================================================

describe('mergeProjects', () => {
  let testDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-dedup-test-'));
    cleanup = _setTestDir(testDir);
  });

  afterEach(() => {
    cleanup();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function insertProject(id: string, title: string, entities: string[], sessionFile: string) {
    const db = getDb(dbPath());
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO projects (id, title, stage, summary, entities, created_at, updated_at, last_activity_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
      [id, title, `Summary for ${title}`, JSON.stringify(entities), now, now, now],
    );
    db.run(
      `INSERT INTO project_sessions (project_id, session_file, linked_at) VALUES (?, ?, ?)`,
      [id, sessionFile, now],
    );
  }

  function getProject(id: string) {
    return getDb(dbPath()).all(`SELECT * FROM projects WHERE id = ?`, [id])[0] as Record<string, unknown> | undefined;
  }

  function getSessionCount(id: string) {
    const row = getDb(dbPath()).all(`SELECT COUNT(*) as cnt FROM project_sessions WHERE project_id = ?`, [id])[0] as Record<string, unknown>;
    return row.cnt as number;
  }

  it('deletes loser, migrates sessions, unions entities', () => {
    insertProject('keep', 'Fix Tracker Hook', ['src/tracker.ts', 'src/hook.ts'], '/session-a.jsonl');
    insertProject('remove', 'Fix Tracker Hook Errors', ['src/tracker.ts', 'src/errors.ts'], '/session-b.jsonl');

    mergeProjects('keep', 'remove');

    expect(getProject('keep')).toBeDefined();
    expect(getProject('remove')).toBeUndefined();
    expect(getSessionCount('keep')).toBe(2);

    const entities = JSON.parse(getProject('keep')!.entities as string) as string[];
    expect(new Set(entities)).toEqual(new Set(['src/tracker.ts', 'src/hook.ts', 'src/errors.ts']));
  });

  it('preserves older created_at and applies title/summary overrides', () => {
    insertProject('keep', 'Old Title', ['x.ts'], '/s1.jsonl');
    insertProject('remove', 'Other Title', ['y.ts'], '/s2.jsonl');

    const db = getDb(dbPath());
    db.run(`UPDATE projects SET created_at = '2025-01-01T00:00:00Z' WHERE id = 'remove'`);
    db.run(`UPDATE projects SET created_at = '2026-03-01T00:00:00Z' WHERE id = 'keep'`);

    mergeProjects('keep', 'remove', 'Better Title', 'Combined summary');

    const survivor = getProject('keep')!;
    expect(survivor.created_at).toBe('2025-01-01T00:00:00Z');
    expect(survivor.title).toBe('Better Title');
    expect(survivor.summary).toBe('Combined summary');
  });

  it('no-ops for nonexistent IDs, dedupes overlapping sessions', () => {
    insertProject('keep', 'Project A', ['a.ts'], '/shared.jsonl');
    insertProject('remove', 'Project B', ['b.ts'], '/shared.jsonl');

    // Nonexistent target — no throw, no damage
    mergeProjects('keep', 'nonexistent');
    expect(getProject('keep')).toBeDefined();

    // Overlapping session file — INSERT OR IGNORE dedupes
    mergeProjects('keep', 'remove');
    expect(getProject('remove')).toBeUndefined();
    expect(getSessionCount('keep')).toBe(1);
  });
});
