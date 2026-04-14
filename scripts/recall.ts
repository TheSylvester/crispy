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
 *   (message-id auto-centers the read window on the matched turn)
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
import { getDbPath, listSessions } from '../src/core/recall/memory-queries.js';
import { readSessionMessages, getMessageByUuid } from '../src/core/recall/message-store.js';

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
// --context is accepted but ignored (centering is automatic when message-id is given)
const since = flagValue('--since');
const projectFlag = flagValue('--project');
const allProjects = hasFlag('--all');
const reverse = hasFlag('--reverse');

// Project scoping: default to CWD (inherited from parent session's projectPath),
// --project overrides, --all disables scoping entirely.
const effectiveProject = allProjects ? undefined : projectFlag ?? process.cwd();

// Collect positional args (skip flags and their values)
const FLAG_WITH_VALUE = new Set(['--limit', '--offset', '--since', '--project']);
const FLAG_BOOLEAN = new Set(['--raw', '--help', '-h', '--list', '--all', '--reverse']);

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
  recall <session-id> <message-id>   Read centered on matched message
  recall --list                      List recent sessions

ARGUMENTS
  query         Free-text search (FTS5 + optional semantic)
  session-id    Full or prefix UUID of a session
  message-id    Full or prefix UUID of a message within the session

FLAGS
  --limit N       Max results for search/list modes (search: 200, list: 50)
  --offset N      Continue reading from this message sequence number
  --since DATE    Only sessions after this date (list and search modes, ISO-8601)
  --project PATH  Scope to a specific project path (default: CWD)
  --all           Search across all projects (disables project scoping)
  --reverse       Read session messages newest-first (default: oldest-first)
  --raw           Output raw JSON instead of formatted tables
  --list          List sessions mode
  --help, -h      Show this help

WORKFLOW
  1. Search:  recall "your query"
  2. Read the matched message:  recall <session-id> <message-id>
     This auto-centers on the match and shows surrounding turns.
     Use --offset from the footer to continue reading forward.
  3. Only use recall <session-id> (no message-id) when you need
     to start from the beginning of a session.

EXAMPLES
  recall "MCP server rename"
  recall "refactored provider config" --limit 30 --since 2025-06-01
  recall a1b2c3d4 e5f6a7b8
  recall a1b2c3d4 --reverse
  recall --list --since 2025-06-01
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
  const sessions = listSessions(getDbPath(), effectiveLimit, since, undefined, effectiveProject);

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

const CHAR_BUDGET = parseInt(process.env.RECALL_CHAR_BUDGET || '20000', 10);
const FETCH_BATCH = 100; // fetch generously, budget-cap on output

function printMessages(
  page: NonNullable<ReturnType<typeof readSessionMessages>>,
  opts: { targetMessageId?: string; startOffset: number },
) {
  let totalChars = 0;
  let printed = 0;

  for (const m of page.messages) {
    const isTarget = opts.targetMessageId && m.message_id === opts.targetMessageId;
    const marker = opts.targetMessageId ? (isTarget ? '>>>' : '   ') : '';
    const role = m.role ?? (m.message_seq % 2 === 0 ? 'user' : 'assistant');
    const dateStr = m.created_at
      ? new Date(m.created_at).toISOString().slice(0, 19).replace('T', ' ')
      : '';

    // Format this message
    const header = `\n${marker}${marker ? ' ' : ''}[${m.message_seq}] ${role.toUpperCase()}  ${dateStr}`;
    const body = m.text;
    const msgChars = header.length + body.length;

    // Stop if adding this message would exceed budget (but always include at least 1)
    if (totalChars + msgChars > CHAR_BUDGET && printed > 0) break;

    console.log(header);
    console.log(body);
    totalChars += msgChars;
    printed++;
  }

  const nextOffset = opts.startOffset + printed;
  const hasMore = nextOffset < page.total_messages;
  if (hasMore) {
    const reverseFlag = reverse ? ' --reverse' : '';
    console.log(`\n--- ${printed} messages, ${totalChars} chars. Use${reverseFlag} --offset ${nextOffset} to see more (${page.total_messages - nextOffset} remaining) ---`);
  } else {
    console.log(`\n--- ${printed} messages, ${totalChars} chars. End of session. ---`);
  }
}

function runReadSession(sessionId: string) {
  const page = readSessionMessages(sessionId, offset, FETCH_BATCH, reverse);

  if (!page) {
    console.error(`No messages found for session ${sessionId}`);
    process.exit(1);
  }

  if (raw) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }

  console.log(`Session: ${page.session_id}`);
  console.log(`Messages: ${page.total_messages} total (reading from offset ${page.showing_offset})`);
  console.log('---');

  printMessages(page, { startOffset: offset });
}

// ---------------------------------------------------------------------------
// Mode: Read turn (centered on matched message)
// ---------------------------------------------------------------------------

function runReadTurn(sessionId: string, messageId: string) {
  const record = getMessageByUuid(sessionId, messageId);
  if (!record) {
    console.error(`Message ${messageId} not found in session ${sessionId}`);
    process.exit(1);
  }

  // Fetch a generous batch centered on the match
  const centeredOffset = Math.max(0, record.message_seq - Math.floor(FETCH_BATCH / 2));
  const page = readSessionMessages(sessionId, centeredOffset, FETCH_BATCH, reverse);

  if (!page) {
    console.error(`No messages found for session ${sessionId}`);
    process.exit(1);
  }

  if (raw) {
    console.log(JSON.stringify({ ...page, target_message_id: messageId, target_message_seq: record.message_seq }, null, 2));
    return;
  }

  // Find the match index in the fetched array
  const matchIdx = page.messages.findIndex(m => m.message_id === messageId);
  if (matchIdx === -1) {
    // Fallback: match not in fetched window, just print from offset
    console.log(`Session: ${page.session_id}`);
    console.log(`Match at seq ${record.message_seq} — ${page.total_messages} total`);
    console.log('---');
    printMessages(page, { targetMessageId: messageId, startOffset: centeredOffset });
    return;
  }

  // Expand outward from match: 30% budget backward, 70% forward
  const backBudget = Math.floor(CHAR_BUDGET * 0.3);
  const fwdBudget = CHAR_BUDGET - backBudget;

  // Expand backward from match (not including match itself)
  let backChars = 0;
  let firstIdx = matchIdx;
  for (let i = matchIdx - 1; i >= 0; i--) {
    const msgChars = page.messages[i]!.text.length + 80; // ~80 for header/metadata
    if (backChars + msgChars > backBudget) break;
    backChars += msgChars;
    firstIdx = i;
  }

  // Expand forward from match (including match itself)
  let fwdChars = 0;
  let lastIdx = matchIdx - 1; // will be incremented to at least matchIdx
  for (let i = matchIdx; i < page.messages.length; i++) {
    const msgChars = page.messages[i]!.text.length + 80;
    if (fwdChars + msgChars > fwdBudget && i > matchIdx) break; // always include match
    fwdChars += msgChars;
    lastIdx = i;
  }

  // If backward budget wasn't fully used, give remainder to forward
  const backRemaining = backBudget - backChars;
  if (backRemaining > 0) {
    for (let i = lastIdx + 1; i < page.messages.length; i++) {
      const msgChars = page.messages[i]!.text.length + 80;
      if (fwdChars + msgChars > fwdBudget + backRemaining) break;
      fwdChars += msgChars;
      lastIdx = i;
    }
  }

  // If forward budget wasn't fully used, give remainder to backward
  const fwdRemaining = fwdBudget - fwdChars;
  if (fwdRemaining > 0) {
    for (let i = firstIdx - 1; i >= 0; i--) {
      const msgChars = page.messages[i]!.text.length + 80;
      if (backChars + msgChars > backBudget + fwdRemaining) break;
      backChars += msgChars;
      firstIdx = i;
    }
  }

  const selected = page.messages.slice(firstIdx, lastIdx + 1);
  const firstSeq = selected[0]!.message_seq;
  const lastSeq = selected[selected.length - 1]!.message_seq;
  const nextOffset = lastSeq + 1;

  console.log(`Session: ${page.session_id}`);
  console.log(`Match at seq ${record.message_seq} — showing seq ${firstSeq}–${lastSeq} of ${page.total_messages}`);
  console.log('---');

  let totalChars = 0;
  for (const m of selected) {
    const isTarget = m.message_id === messageId;
    const marker = isTarget ? '>>>' : '   ';
    const role = m.role ?? (m.message_seq % 2 === 0 ? 'user' : 'assistant');
    const dateStr = m.created_at
      ? new Date(m.created_at).toISOString().slice(0, 19).replace('T', ' ')
      : '';
    console.log(`\n${marker} [${m.message_seq}] ${role.toUpperCase()}  ${dateStr}`);
    console.log(m.text);
    totalChars += m.text.length;
  }

  const hasMore = nextOffset < page.total_messages;
  if (hasMore) {
    console.log(`\n--- ${selected.length} messages, ${totalChars} chars. First: seq ${firstSeq}. Continue: --offset ${nextOffset} (${page.total_messages - nextOffset} remaining) ---`);
  } else {
    console.log(`\n--- ${selected.length} messages, ${totalChars} chars. First: seq ${firstSeq}. End of session. ---`);
  }
}

// ---------------------------------------------------------------------------
// Mode: Search
// ---------------------------------------------------------------------------

async function runSearch(query: string) {
  initDb();
  const ceiling = limit > 0 ? limit : 200;
  const r = await dualPathSearch(query, { limit: ceiling, projectId: effectiveProject });
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
    best_message_id: string;
    best_message_seq: number;
    tag: string;
  }

  const sessions: SessionRow[] = [];
  const seen = new Map<string, number>();
  const sessionPaths = new Map<string, Set<string>>();

  for (let i = 0; i < trimmed.length; i++) {
    const x = trimmed[i]!;
    const sid = x.result.session_id;

    let pathSet = sessionPaths.get(sid);
    if (!pathSet) {
      pathSet = new Set<string>();
      sessionPaths.set(sid, pathSet);
    }
    for (const p of x.paths) pathSet.add(p);

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
          .slice(0, 400)
          .replace(/\n/g, ' '),
        hits: 1,
        score: x.score,
        best_message_id: x.result.message_id,
        best_message_seq: x.result.message_seq,
        tag: '',
      });
    }
  }

  for (const s of sessions) {
    const paths = sessionPaths.get(s.session_id);
    if (paths?.has('fts5') && paths?.has('semantic')) {
      s.tag = '[FTS5+SEMANTIC]';
    } else if (paths?.has('semantic')) {
      s.tag = '[SEMANTIC-ONLY]';
    } else {
      s.tag = '[FTS5-ONLY]';
    }
  }

  // --- Paginate sessions ---
  const PAGE_SIZE = 75;
  const totalSessions = sessions.length;
  const pageStart = Math.min(offset, totalSessions);
  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalSessions);
  const page = sessions.slice(pageStart, pageEnd);
  const hasMore = pageEnd < totalSessions;

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
      unique_sessions: totalSessions,
      showing_offset: pageStart,
      showing_count: page.length,
      has_more: hasMore,
      sessions: page,
    }, null, 2));
  } else {
    console.log(`Query: "${query}"`);
    console.log(`Results: ${trimmed.length} messages, ${totalSessions} unique sessions (showing ${pageStart + 1}-${pageEnd})`);
    console.log(`Paths: FTS5=${r.ftsCount}  Semantic=${r.semanticCount} (${r.semanticAvailable ? 'active' : 'UNAVAILABLE'})`);
    if (cutoffIdx < scored.length) {
      console.log(`Cutoff: position ${cutoffIdx} of ${scored.length} (score gap detected)`);
    }
    console.log('---');

    const rankW = 4;
    const idW = 10;
    const msgW = 10;
    const dateW = 12;
    const tagW = 17;
    const hitsW = 6;

    console.log(
      '#'.padStart(rankW) + '  ' +
      'Session'.padEnd(idW) +
      'Msg'.padEnd(msgW) +
      'Date'.padEnd(dateW) +
      'Tag'.padEnd(tagW) +
      'Hits'.padStart(hitsW) + '  ' +
      'Snippet'
    );

    for (const s of page) {
      console.log(
        String(s.rank).padStart(rankW) + '  ' +
        s.short_id.padEnd(idW) +
        s.best_message_id.slice(0, 8).padEnd(msgW) +
        s.date.padEnd(dateW) +
        s.tag.padEnd(tagW) +
        String(s.hits).padStart(hitsW) + '  ' +
        s.snippet
      );
    }

    if (hasMore) {
      console.log(`\n--- Showing ${pageStart + 1}-${pageEnd} of ${totalSessions} sessions. Next page: --offset ${pageEnd} ---`);
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
