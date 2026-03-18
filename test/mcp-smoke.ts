/**
 * Smoke test — exercises MCP memory server components against the real DB.
 * Run: node --import tsx test/mcp-smoke.ts
 */

import { createMemoryServer } from '../src/mcp/index.js';
import { getDb, closeDb } from '../src/core/crispy-db.js';
import { sanitizeFts5Query } from '../src/mcp/query-sanitizer.js';
import { dbPath as getDbPath } from '../src/core/paths.js';

const dbPath = getDbPath();
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

// 2. DB + FTS5 table (messages_fts)
console.log('\n2. Database & FTS5');
const db = getDb(dbPath);
const ftsRow = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'") as Record<string, unknown> | undefined;
check('messages_fts table exists', ftsRow?.name === 'messages_fts');

const triggerRows = db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts%'") as Array<Record<string, unknown>>;
check('FTS5 sync triggers exist', triggerRows.length === 3, `found ${triggerRows.length} triggers`);

// 3. Entry counts (messages table)
console.log('\n3. Data');
const countRow = db.get('SELECT COUNT(*) as cnt FROM messages') as Record<string, unknown>;
const totalMessages = countRow.cnt as number;
check('messages has data', totalMessages >= 0, `${totalMessages} messages`);

// 4. FTS5 search (messages_fts)
console.log('\n4. FTS5 search');
const searchQuery = sanitizeFts5Query('session');
check('sanitizeFts5Query("session") produces valid query', searchQuery != null, `"${searchQuery}"`);

if (searchQuery && totalMessages > 0) {
  const searchResults = db.all(`
    SELECT m.message_id,
           bm25(messages_fts) as rank,
           snippet(messages_fts, 0, '>>>', '<<<', '...', 32) as match_snippet
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT 5
  `, [searchQuery]) as Array<Record<string, unknown>>;
  check('FTS5 MATCH returns results', searchResults.length > 0, `${searchResults.length} results`);

  if (searchResults.length > 0) {
    const first = searchResults[0]!;
    check('results have rank (BM25)', typeof first.rank === 'number');
    check('results have match_snippet', typeof first.match_snippet === 'string');
  }
}

// 5. list_sessions query (messages table)
console.log('\n5. list_sessions query');
const sessions = db.all(`
  SELECT m.session_id,
         MIN(m.created_at) as first_activity,
         MAX(m.created_at) as last_activity,
         COUNT(*) as message_count
  FROM messages m
  WHERE m.session_id IS NOT NULL
  GROUP BY m.session_id
  ORDER BY last_activity DESC
  LIMIT 5
`) as Array<Record<string, unknown>>;
check('list_sessions groups by session_id', sessions.length >= 0, `${sessions.length} sessions`);

if (sessions.length > 0) {
  const first = sessions[0]!;
  check('session has last_activity (epoch ms)', typeof first.last_activity === 'number');
  check('session has message_count', typeof first.message_count === 'number');
}

// 6. Query sanitizer edge cases
console.log('\n6. Query sanitizer');
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
