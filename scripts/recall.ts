/**
 * recall — Unified CLI for Crispy's recall system
 *
 * Argument inference:
 *   recall "query"                  → search mode
 *   recall <session-id>             → read session messages
 *   recall <session-id> <msg-id>    → read a specific turn
 *   recall --list                   → list sessions
 *   recall --help                   → usage
 *
 * Flags:
 *   --limit N     Max results (default varies by mode)
 *   --offset N    Pagination offset for session reads
 *   --context N   Extra turns around a message (turn mode, 0-5)
 *   --since DATE  Filter by date (list/search modes; ISO-8601)
 *   --raw         JSON output instead of formatted tables
 *   --help        Print usage
 *   --list        List sessions
 *
 * Search mode uses dual-path (FTS5 + semantic) search with score-gap cutoff
 * and deduplication by session.
 */

import { dualPathSearch } from '../src/core/recall/vector-search.js';
import { getDb } from '../src/core/crispy-db.js';
import { getDbPath, listSessions, readMessageTurn } from '../src/core/recall/memory-queries.js';
import { readSessionMessages } from '../src/core/recall/message-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_PREFIX = /^[0-9a-f]{8}/i;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

function flagValue(name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function flagInt(name: string, fallback: number): number {
  const v = flagValue(name);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

const raw = hasFlag('--raw');
const showHelp = hasFlag('--help') || hasFlag('-h');
const listMode = hasFlag('--list');
const limit = flagInt('--limit', -1);   // -1 = use mode default
const offset = flagInt('--offset', 0);
const context = flagInt('--context', 0);
const since = flagValue('--since');

// Collect positional args (skip flags and their values)
const FLAG_WITH_VALUE = new Set(['--limit', '--offset', '--context', '--since']);
const FLAG_BOOLEAN = new Set(['--raw', '--help', '-h', '--list']);

const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (FLAG_BOOLEAN.has(a)) continue;
  if (FLAG_WITH_VALUE.has(a)) { i++; continue; }
  positional.push(a);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
recall — Unified CLI for Crispy's recall system

USAGE
  recall "query"                     Search sessions by text
  recall <session-id>                Read messages from a session
  recall <session-id> <message-id>   Read a specific turn with context
  recall --list                      List recent sessions

ARGUMENTS
  query         Free-text search (FTS5 + optional semantic)
  session-id    Full or prefix UUID of a session
  message-id    Full or prefix UUID of a message within the session

FLAGS
  --limit N     Max results (search: 200, list: 50, read: 20)
  --offset N    Pagination offset for session reads (default 0)
  --context N   Extra turns around target message, 0-5 (default 0)
  --since DATE  Only sessions after this date (list mode only, ISO-8601)
  --raw         Output raw JSON instead of formatted tables
  --list        List sessions mode
  --help, -h    Show this help

EXAMPLES
  recall "MCP server rename"
  recall "refactored provider config" --limit 30 --since 2025-06-01
  recall --list --since 2025-06-01
  recall a1b2c3d4
  recall a1b2c3d4 --offset 20 --limit 10
  recall a1b2c3d4 e5f6a7b8 --context 2
`.trim());
}

// ---------------------------------------------------------------------------
// Init DB
// ---------------------------------------------------------------------------

function initDb() {
  getDb(getDbPath());
}

/** Resolve a session ID prefix to a full UUID via the messages table. */
function resolveSessionId(prefix: string): string {
  const clean = prefix.trim().replace(/[^0-9a-f-]/gi, '');
  if (clean.length >= 36) return clean.slice(0, 36);
  const rows = getDb(getDbPath()).all(
    'SELECT DISTINCT session_id FROM messages WHERE session_id LIKE ? ORDER BY session_id ASC LIMIT 2',
    [`${clean}%`],
  ) as { session_id: string }[];
  if (rows.length === 0) {
    console.error(`No session found matching prefix: ${prefix}`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Ambiguous prefix "${prefix}" — matches multiple sessions:`);
    for (const r of rows) console.error(`  ${r.session_id}`);
    process.exit(1);
  }
  return rows[0]!.session_id;
}

/** Resolve a message ID prefix to a full UUID within a session. */
function resolveMessageId(sessionId: string, prefix: string): string {
  const clean = prefix.trim().replace(/[^0-9a-f-]/gi, '');
  if (clean.length >= 36) return clean.slice(0, 36);
  const rows = getDb(getDbPath()).all(
    'SELECT DISTINCT message_id FROM messages WHERE session_id = ? AND message_id LIKE ? ORDER BY message_id ASC LIMIT 2',
    [sessionId, `${clean}%`],
  ) as { message_id: string }[];
  if (rows.length === 0) {
    console.error(`No message found in session ${sessionId.slice(0, 8)} matching prefix: ${prefix}`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Ambiguous message ID prefix "${prefix}" — matches multiple messages:`);
    for (const r of rows) console.error(`  ${r.message_id}`);
    process.exit(1);
  }
  return rows[0]!.message_id;
}

// ---------------------------------------------------------------------------
// Mode: List sessions
// ---------------------------------------------------------------------------

function runList() {
  initDb();
  const effectiveLimit = limit > 0 ? limit : 50;
  const sessions = listSessions(getDbPath(), effectiveLimit, since);

  if (raw) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  // Table output
  const idW = 10;
  const dateW = 12;
  const msgsW = 6;

  console.log(
    'Session'.padEnd(idW) +
    'Last active'.padEnd(dateW) +
    'Msgs'.padStart(msgsW) + '  ' +
    'Title'
  );
  console.log('-'.repeat(70));

  for (const s of sessions) {
    const date = s.last_activity
      ? new Date(s.last_activity).toISOString().slice(0, 10)
      : 'unknown';
    console.log(
      s.session_id.slice(0, 8).padEnd(idW) +
      date.padEnd(dateW) +
      String(s.message_count).padStart(msgsW) + '  ' +
      (s.title || '(untitled)')
    );
  }

  console.log(`\n${sessions.length} session(s)`);
}

// ---------------------------------------------------------------------------
// Mode: Read session messages
// ---------------------------------------------------------------------------

function runReadSession(sessionId: string) {
  const effectiveLimit = limit > 0 ? limit : 20;
  const page = readSessionMessages(sessionId, offset, effectiveLimit);

  if (!page) {
    console.error(`No messages found for session ${sessionId}`);
    process.exit(1);
  }

  if (raw) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }

  console.log(`Session: ${page.session_id}`);
  console.log(`Messages: ${page.showing_count} of ${page.total_messages} (offset ${page.showing_offset})${page.has_more ? ' — more available' : ''}`);
  console.log('---');

  for (const m of page.messages) {
    const role = m.role ?? (m.message_seq % 2 === 0 ? 'user' : 'assistant');
    const dateStr = m.created_at
      ? new Date(m.created_at).toISOString().slice(0, 19).replace('T', ' ')
      : '';
    console.log(`\n[${m.message_seq}] ${role.toUpperCase()}  ${dateStr}`);
    console.log(m.text.slice(0, 2000));
    if (m.text.length > 2000) console.log(`... (${m.text.length} chars total)`);
  }

  if (page.has_more) {
    console.log(`\n--- Use --offset ${page.showing_offset + page.showing_count} to see more ---`);
  }
}

// ---------------------------------------------------------------------------
// Mode: Read turn
// ---------------------------------------------------------------------------

function runReadTurn(sessionId: string, messageId: string) {
  const result = readMessageTurn(sessionId, messageId, context);

  if (!result) {
    console.error(`Message ${messageId} not found in session ${sessionId}`);
    process.exit(1);
  }

  if (raw) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Turn at seq ${result.messageSeq}`);
  if (result.showing_seq_range) {
    console.log(`Context: seq ${result.showing_seq_range[0]}–${result.showing_seq_range[1]}` +
      (result.session_total_messages ? ` of ${result.session_total_messages}` : ''));
  }
  console.log('---');

  if (result.context_messages) {
    for (const cm of result.context_messages) {
      const tag = cm.is_target ? '>>>' : '   ';
      const role = cm.role ?? (cm.message_seq % 2 === 0 ? 'user' : 'assistant');
      console.log(`\n${tag} [${cm.message_seq}] ${role.toUpperCase()}`);
      console.log(cm.text.slice(0, 2000));
      if (cm.text.length > 2000) console.log(`... (${cm.text.length} chars total)`);
    }
  } else {
    console.log('\nUSER:');
    console.log(result.userText.slice(0, 2000));
    if (result.userText.length > 2000) console.log(`... (${result.userText.length} chars total)`);
    console.log('\nASSISTANT:');
    console.log(result.assistantText.slice(0, 2000));
    if (result.assistantText.length > 2000) console.log(`... (${result.assistantText.length} chars total)`);
  }
}

// ---------------------------------------------------------------------------
// Mode: Search
// ---------------------------------------------------------------------------

async function runSearch(query: string) {
  initDb();
  const ceiling = limit > 0 ? limit : 200;
  const r = await dualPathSearch(query, { limit: ceiling });
  let { scored } = r;

  // Filter by --since date if provided
  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!isNaN(sinceMs)) {
      scored = scored.filter(x => {
        const created = x.result.created_at ?? 0;
        return created >= sinceMs;
      });
    } else {
      console.error(`Invalid --since date: "${since}" (expected ISO-8601)`);
      process.exit(1);
    }
  }

  // --- Score-gap cutoff ---
  // Scan from position 10 onward. Find the largest relative drop between
  // consecutive scores. If > 15%, truncate there.
  let cutoffIdx = scored.length;
  if (scored.length > 10) {
    let maxDrop = 0;
    let maxDropIdx = -1;
    for (let i = 10; i < scored.length - 1; i++) {
      const curr = scored[i]!.score;
      const next = scored[i + 1]!.score;
      if (curr > 0) {
        const drop = (curr - next) / curr;
        if (drop > maxDrop) {
          maxDrop = drop;
          maxDropIdx = i + 1;
        }
      }
    }
    if (maxDrop > 0.15) {
      cutoffIdx = maxDropIdx;
    }
  }

  const trimmed = scored.slice(0, cutoffIdx);

  // --- Deduplicate by session_id, keep highest-ranked entry ---
  interface SessionRow {
    rank: number;
    session_id: string;
    short_id: string;
    date: string;
    snippet: string;
    hits: number;
    score: number;
  }

  const sessions: SessionRow[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < trimmed.length; i++) {
    const x = trimmed[i]!;
    const sid = x.result.session_id;
    const idx = seen.get(sid);
    if (idx !== undefined) {
      sessions[idx]!.hits++;
    } else {
      seen.set(sid, sessions.length);
      sessions.push({
        rank: sessions.length + 1,
        session_id: sid,
        short_id: sid.slice(0, 8),
        date: x.result.created_at
          ? new Date(x.result.created_at).toISOString().slice(0, 10)
          : 'unknown',
        snippet: (x.result.match_snippet || x.result.message_preview || '')
          .slice(0, 120)
          .replace(/\n/g, ' '),
        hits: 1,
        score: x.score,
      });
    }
  }

  // --- Output ---
  if (raw) {
    console.log(JSON.stringify({
      query,
      total_messages: trimmed.length,
      total_before_cutoff: scored.length,
      cutoff_applied: cutoffIdx < scored.length,
      fts_count: r.ftsCount,
      semantic_count: r.semanticCount,
      semantic_available: r.semanticAvailable,
      unique_sessions: sessions.length,
      sessions,
    }, null, 2));
  } else {
    console.log(`Query: "${query}"`);
    console.log(`Results: ${trimmed.length} messages (${scored.length} before cutoff), ${sessions.length} unique sessions`);
    console.log(`Paths: FTS5=${r.ftsCount}  Semantic=${r.semanticCount} (${r.semanticAvailable ? 'active' : 'UNAVAILABLE'})`);
    if (cutoffIdx < scored.length) {
      console.log(`Cutoff: position ${cutoffIdx} of ${scored.length} (score gap detected)`);
    }
    console.log('---');

    const rankW = 4;
    const idW = 10;
    const dateW = 12;
    const hitsW = 6;

    console.log(
      '#'.padStart(rankW) + '  ' +
      'Session'.padEnd(idW) +
      'Date'.padEnd(dateW) +
      'Hits'.padStart(hitsW) + '  ' +
      'Snippet'
    );

    for (const s of sessions) {
      console.log(
        String(s.rank).padStart(rankW) + '  ' +
        s.short_id.padEnd(idW) +
        s.date.padEnd(dateW) +
        String(s.hits).padStart(hitsW) + '  ' +
        s.snippet
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
  if (showHelp) {
    printHelp();
    process.exit(0);
  }

  if (listMode) {
    runList();
    process.exit(0);
  }

  // Two UUID-like positional args → turn read
  if (positional.length >= 2 && UUID_PREFIX.test(positional[0]!) && UUID_PREFIX.test(positional[1]!)) {
    initDb();
    const sessionId = resolveSessionId(positional[0]!);
    const messageId = resolveMessageId(sessionId, positional[1]!);
    runReadTurn(sessionId, messageId);
    process.exit(0);
  }

  // Single UUID-like positional arg → session read
  if (positional.length === 1 && UUID_PREFIX.test(positional[0]!)) {
    initDb();
    runReadSession(resolveSessionId(positional[0]!));
    process.exit(0);
  }

  // Otherwise → search query
  const query = positional.join(' ');
  if (!query) {
    console.error('No query provided. Use --help for usage.');
    process.exit(1);
  }

  await runSearch(query);
  process.exit(0);
}

main();
