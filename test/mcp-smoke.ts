/**
 * Smoke test — exercises MCP memory server components against the real DB.
 * Run: node --import tsx test/mcp-smoke.ts
 */

import { createMemoryServer } from '../src/mcp/index.js';
import { getDb, closeDb } from '../src/core/crispy-db.js';
import { sanitizeFts5Query } from '../src/mcp/query-sanitizer.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = join(homedir(), '.crispy', 'crispy.db');
let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✅ ${label}` + (detail ? ` — ${detail}` : ''));
    passed++;
  } else {
    console.log(`  ❌ ${label}` + (detail ? ` — ${detail}` : ''));
    failed++;
  }
}

console.log('MCP Memory Server Smoke Test');
console.log('============================\n');

// 1. createMemoryServer
console.log('1. Server creation');
const server = createMemoryServer();
check('createMemoryServer() returns config', server != null);
check('name is "memory"', server.name === 'memory');
check('type is "sdk"', server.type === 'sdk');
check('instance exists', server.instance != null);

// 2. DB + FTS5 table
console.log('\n2. Database & FTS5');
const db = getDb(dbPath);
const ftsRow = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='session_meta_fts'") as Record<string, unknown> | undefined;
check('session_meta_fts table exists', ftsRow?.name === 'session_meta_fts');

const triggerRows = db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'session_meta_fts%'") as Array<Record<string, unknown>>;
check('FTS5 sync triggers exist', triggerRows.length === 3, `found ${triggerRows.length} triggers`);

// 3. Entry counts
console.log('\n3. Data');
const countRow = db.get('SELECT COUNT(*) as cnt FROM session_meta') as Record<string, unknown>;
const totalEntries = countRow.cnt as number;
check('session_meta has data', totalEntries > 0, `${totalEntries} entries`);

const rosieCount = db.get("SELECT COUNT(*) as cnt FROM session_meta WHERE kind = 'rosie-meta'") as Record<string, unknown>;
check('rosie-meta entries exist', (rosieCount.cnt as number) > 0, `${rosieCount.cnt} rosie-meta entries`);

// 4. FTS5 search
console.log('\n4. FTS5 search');
const searchQuery = sanitizeFts5Query('session');
check('sanitizeFts5Query("session") produces valid query', searchQuery != null, `"${searchQuery}"`);

if (searchQuery) {
  const searchResults = db.all(`
    SELECT ae.id, ae.kind, ae.quest, ae.title,
           bm25(session_meta_fts) as rank,
           snippet(session_meta_fts, 1, '>>>', '<<<', '...', 32) as match_snippet
    FROM session_meta_fts
    JOIN session_meta ae ON ae.id = session_meta_fts.rowid
    WHERE session_meta_fts MATCH ?
    ORDER BY rank
    LIMIT 5
  `, [searchQuery]) as Array<Record<string, unknown>>;
  check('FTS5 MATCH returns results', searchResults.length > 0, `${searchResults.length} results`);

  if (searchResults.length > 0) {
    const first = searchResults[0]!;
    check('results have rank (BM25)', typeof first.rank === 'number');
    check('results have match_snippet', typeof first.match_snippet === 'string');
    console.log(`    top result: kind=${first.kind}, rank=${(first.rank as number).toFixed(2)}, quest="${first.quest || first.title || '(none)'}"`);
  }
}

// 5. list_sessions query
console.log('\n5. list_sessions query');
const sessions = db.all(`
  SELECT file, MAX(timestamp) as last_activity,
         MAX(CASE WHEN kind = 'rosie-meta' THEN quest END) as quest,
         MAX(CASE WHEN kind = 'rosie-meta' THEN title END) as title,
         MAX(CASE WHEN kind = 'rosie-meta' THEN status END) as status,
         COUNT(*) as entry_count
  FROM session_meta
  GROUP BY file
  ORDER BY last_activity DESC
  LIMIT 5
`) as Array<Record<string, unknown>>;
check('list_sessions groups by file', sessions.length > 0, `${sessions.length} sessions`);

if (sessions.length > 0) {
  const first = sessions[0]!;
  check('session has last_activity', typeof first.last_activity === 'string');
  check('session has entry_count', typeof first.entry_count === 'number');
  console.log(`    top session: ${first.title || first.quest || 'untitled'} (${first.entry_count} entries)`);
}

// 6. session_context query
console.log('\n6. session_context query');
if (sessions.length > 0) {
  const file = sessions[0]!.file as string;
  const context = db.all(`
    SELECT id, timestamp, kind, quest, summary, title
    FROM session_meta
    WHERE file = ?
    ORDER BY timestamp ASC
    LIMIT 5
  `, [file]) as Array<Record<string, unknown>>;
  check('session_context returns entries', context.length > 0, `${context.length} entries for ${file.split('/').pop()}`);
}

// 7. Query sanitizer edge cases
console.log('\n7. Query sanitizer');
check('empty string → null', sanitizeFts5Query('') === null);
check('whitespace → null', sanitizeFts5Query('   ') === null);
check('simple word passes through', sanitizeFts5Query('hello') === 'hello');
check('AND operator preserved', (sanitizeFts5Query('hello AND world') ?? '').includes('AND'));
check('unbalanced quotes handled', sanitizeFts5Query('"hello world') != null);
check('multi-word → quoted AND', sanitizeFts5Query('rosie bot') === '"rosie" "bot"');

// Summary
console.log('\n============================');
console.log(`Results: ${passed} passed, ${failed} failed`);

closeDb();
process.exit(failed > 0 ? 1 : 0);
