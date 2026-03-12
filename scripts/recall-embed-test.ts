/**
 * recall-embed-test — Profiling harness for the message-level embedding pipeline.
 *
 * Bootstraps the adapter system (same as backfill.ts), then:
 *   1. Backfills message-level FTS5 index for recent sessions (if needed)
 *   2. Embeds recent messages with Nomic Embed Code
 *   3. Runs dual-path search queries and reports which path found what
 *
 * Every pipeline stage is profiled with wall-clock timing. Use --verbose
 * for per-message breakdowns, otherwise output is per-session summaries.
 *
 * Usage:
 *   npx tsx scripts/recall-embed-test.ts "your query" [options]
 *   npx tsx scripts/recall-embed-test.ts --backfill-only -l 10
 *
 * @module scripts/recall-embed-test
 */

delete process.env.CLAUDECODE;

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { createAgentDispatch } from '../src/host/agent-dispatch.js';
import { registerAllAdapters } from '../src/host/adapter-registry.js';
import { initSettings } from '../src/core/settings/index.js';
import { dbPath } from '../src/core/activity-index.js';
import { getDb } from '../src/core/crispy-db.js';
import { listAllSessions } from '../src/core/session-manager.js';
import { ingestSessionMessages } from '../src/core/recall/message-ingest.js';
import {
  hasSessionMessages,
  insertMessageVectors,
  searchMessagesFts,
} from '../src/core/recall/message-store.js';
import type { MessageSearchResult, MessageVectorRecord } from '../src/core/recall/message-store.js';
import { dualPathSearch } from '../src/core/recall/vector-search.js';

// ============================================================================
// CLI
// ============================================================================

function printUsage(): void {
  console.error(`
Usage: npx tsx scripts/recall-embed-test.ts "your query" [options]

Modes:
  (default)          Search using dual-path (FTS5 + semantic)
  --backfill-only    Index + embed recent sessions, then exit
  --compare          Run both FTS5-only and dual-path, show diff

Options:
  --limit, -l <n>       Sessions to index/embed (default: 10)
  --days, -d <n>        Look back N days (default: 3)
  --search-limit <n>    Max search results (default: 10)
  --project-id <path>   Scope search to a project path
  --force               Re-embed already-vectorized sessions
  --verbose, -v         Print extra debug info
  --help, -h            Show this help

Examples:
  # Backfill 10 sessions, then search
  npx tsx scripts/recall-embed-test.ts "dev productivity" -l 10

  # Just backfill without searching
  npx tsx scripts/recall-embed-test.ts --backfill-only -l 50 --days 7

  # Compare FTS5 vs dual-path for a query
  npx tsx scripts/recall-embed-test.ts "project management" --compare

  # Search without backfilling (use existing vectors)
  npx tsx scripts/recall-embed-test.ts "authentication flow" -l 0
`);
}

interface CliOptions {
  query: string | null;
  limit: number;
  days: number;
  searchLimit: number;
  projectId: string | undefined;
  backfillOnly: boolean;
  compare: boolean;
  force: boolean;
  verbose: boolean;
}

function parseCli(): CliOptions | null {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      limit: { type: 'string', short: 'l', default: '10' },
      days: { type: 'string', short: 'd', default: '3' },
      'search-limit': { type: 'string', default: '10' },
      'project-id': { type: 'string' },
      'backfill-only': { type: 'boolean', default: false },
      compare: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return null;
  }

  const query = positionals[0] ?? null;
  const backfillOnly = values['backfill-only'] as boolean;

  if (!query && !backfillOnly) {
    console.error('Error: provide a query or use --backfill-only\n');
    printUsage();
    return null;
  }

  return {
    query,
    limit: Math.max(0, parseInt(values.limit as string, 10) || 10),
    days: Math.max(1, parseInt(values.days as string, 10) || 3),
    searchLimit: Math.max(1, parseInt(values['search-limit'] as string, 10) || 10),
    projectId: values['project-id'] as string | undefined,
    backfillOnly,
    compare: values.compare as boolean,
    force: values.force as boolean,
    verbose: values.verbose as boolean,
  };
}

// ============================================================================
// Profiling helpers
// ============================================================================

/** Returns a stop function that yields elapsed milliseconds. */
function perf(): () => number {
  const t0 = performance.now();
  return () => performance.now() - t0;
}

/** Format milliseconds as a human-readable string. */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a number with thousand separators. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

// ============================================================================
// Helpers
// ============================================================================

function log(msg: string): void {
  console.error(msg);
}

function printResults(label: string, results: MessageSearchResult[]): void {
  log(`\n  ${label} (${results.length} results):`);
  if (results.length === 0) {
    log('    (none)');
    return;
  }
  for (const r of results) {
    const preview = r.message_preview.slice(0, 80).replace(/\n/g, ' ');
    const snippet = r.match_snippet ? ` | snippet: ${r.match_snippet.slice(0, 60)}` : '';
    log(`    [${r.rank.toFixed(3)}] ${r.session_id.slice(0, 12)}… seq=${r.message_seq} | ${preview}…${snippet}`);
  }
}

// ============================================================================
// Backfill: Index + Embed
// ============================================================================

const MAX_EMBED_CHARS = 32_000;

async function runBackfill(opts: CliOptions): Promise<{ indexed: number; embedded: number }> {
  if (opts.limit === 0) {
    log('[backfill] Skipped (limit=0)');
    return { indexed: 0, embedded: 0 };
  }

  const allSessions = listAllSessions();
  let indexed = 0;
  let embedded = 0;

  // ── Phase 1: Index messages (FTS5) ──────────────────────────────────
  log(`\n[backfill] Phase 1 — Indexing messages for up to ${opts.limit} sessions...`);
  const stopPhase1 = perf();
  let indexCount = 0;

  for (const s of allSessions) {
    if (indexCount >= opts.limit) break;
    if (s.isSidechain) continue;
    if (!existsSync(s.path)) continue;
    if (!opts.force && hasSessionMessages(s.sessionId)) continue;

    try {
      const stopSession = perf();
      const result = await ingestSessionMessages(s.sessionId, { force: opts.force });
      const sessionMs = stopSession();

      if (!result.skipped && !result.error) {
        indexed += result.chunksCreated;
        indexCount++;
        log(`  Indexed ${s.sessionId.slice(0, 12)}…: ${result.chunksCreated} messages (${fmtMs(sessionMs)})`);
      }
    } catch (err) {
      if (opts.verbose) log(`  Index error for ${s.sessionId.slice(0, 12)}…: ${err}`);
    }
  }
  log(`  Phase 1 complete: ${fmt(indexed)} messages from ${indexCount} sessions (${fmtMs(stopPhase1())})`);

  // ── Phase 2: Embed messages ─────────────────────────────────────────
  log(`\n[backfill] Phase 2 — Loading embedding model...`);
  const stopModelLoad = perf();

  let embedBatchFn: ((texts: string[]) => Promise<Float32Array[]>) | null = null;
  let quantizeFn: ((f32: Float32Array) => { q8: Int8Array; scale: number }) | null = null;
  let normFn: ((f32: Float32Array) => number) | null = null;

  try {
    const { embedBatch } = await import('../src/core/recall/embedder.js');
    const { quantizeToQ8, computeNorm } = await import('../src/core/recall/quantize.js');
    embedBatchFn = embedBatch;
    quantizeFn = quantizeToQ8;
    normFn = computeNorm;
  } catch (err) {
    log(`  WARN: Embedding model unavailable (${err instanceof Error ? err.message : String(err)})`);
    log('  Semantic search will return no results — FTS5-only mode.');
    return { indexed, embedded };
  }

  // Model import is fast; the actual model load happens on first embed call.
  // We'll capture that timing as part of the first session.
  log(`  Module import: ${fmtMs(stopModelLoad())}`);

  const db = getDb(dbPath());
  const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000;

  const skipClause = opts.force
    ? ''
    : `AND m.session_id NOT IN (
         SELECT DISTINCT m2.session_id FROM messages m2
         JOIN message_vectors mv ON mv.message_id = m2.message_id
       )`;

  const candidates = db.all(`
    SELECT m.session_id, COUNT(*) as msg_count
    FROM messages m
    WHERE m.created_at >= ?
      ${skipClause}
    GROUP BY m.session_id
    ORDER BY MAX(m.created_at) DESC
    LIMIT ?
  `, [cutoff, opts.limit]) as Array<Record<string, unknown>>;

  if (candidates.length === 0) {
    log('  No sessions need embedding (all already vectorized or none in range)');
    return { indexed, embedded };
  }

  const totalCandidateMessages = candidates.reduce((s, c) => s + (c.msg_count as number), 0);
  log(`[backfill] Embedding ${fmt(totalCandidateMessages)} messages from ${candidates.length} sessions...`);

  const stopPhase2 = perf();
  let totalEmbedMs = 0;
  let totalQuantizeMs = 0;
  let totalInsertMs = 0;
  let totalTruncated = 0;
  let modelLoaded = false;

  for (const c of candidates) {
    const sessionId = c.session_id as string;
    const rows = db.all(
      `SELECT message_id, message_text FROM messages WHERE session_id = ? ORDER BY message_seq ASC`,
      [sessionId],
    ) as Array<Record<string, unknown>>;

    const validRows: Array<{ messageId: string; text: string }> = [];
    let truncatedInSession = 0;
    for (const r of rows) {
      const text = (r.message_text as string).trim();
      if (!text) continue;
      if (text.length > MAX_EMBED_CHARS) {
        truncatedInSession++;
        totalTruncated++;
      }
      validRows.push({
        messageId: r.message_id as string,
        text: text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text,
      });
    }
    if (validRows.length === 0) continue;

    try {
      // Embed
      const stopEmbed = perf();
      const texts = validRows.map(r => r.text);
      const vectors = await embedBatchFn!(texts);
      const embedMs = stopEmbed();

      // Capture model load time from first embed call
      if (!modelLoaded) {
        log(`  Model loaded + first session embed: ${fmtMs(embedMs)}`);
        modelLoaded = true;
      }

      totalEmbedMs += embedMs;

      // Quantize
      const stopQuantize = perf();
      const records: MessageVectorRecord[] = [];
      for (let j = 0; j < validRows.length; j++) {
        const f32 = vectors[j]!;
        const { q8, scale } = quantizeFn!(f32);
        const norm = normFn!(f32);
        records.push({ messageId: validRows[j]!.messageId, embeddingQ8: q8, norm, quantScale: scale });
      }
      const quantizeMs = stopQuantize();
      totalQuantizeMs += quantizeMs;

      // Insert
      const stopInsert = perf();
      insertMessageVectors(records);
      const insertMs = stopInsert();
      totalInsertMs += insertMs;

      embedded += records.length;

      const perMsg = embedMs / validRows.length;
      const truncNote = truncatedInSession > 0 ? `, ${truncatedInSession} truncated` : '';
      log(`  ${sessionId.slice(0, 12)}…: ${validRows.length} msgs, embed=${fmtMs(embedMs)} (${perMsg.toFixed(0)}ms/msg), quantize=${fmtMs(quantizeMs)}, insert=${fmtMs(insertMs)}${truncNote}`);
    } catch (err) {
      if (opts.verbose) log(`  Embed error for ${sessionId.slice(0, 12)}…: ${err}`);
    }
  }

  const phase2Ms = stopPhase2();
  const avgPerMsg = embedded > 0 ? totalEmbedMs / embedded : 0;
  log(`  Phase 2 complete: ${fmt(embedded)} messages embedded (${fmtMs(phase2Ms)} total, ${avgPerMsg.toFixed(0)}ms/msg avg)`);
  log(`  Breakdown: embed=${fmtMs(totalEmbedMs)}, quantize=${fmtMs(totalQuantizeMs)}, insert=${fmtMs(totalInsertMs)}`);
  if (totalTruncated > 0) {
    log(`  Truncated: ${totalTruncated} messages exceeded ${fmt(MAX_EMBED_CHARS)} chars`);
  }

  return { indexed, embedded };
}

// ============================================================================
// Search
// ============================================================================

async function runSearch(query: string, opts: CliOptions): Promise<void> {
  const db = getDb(dbPath());

  // Get vector count for context
  const vecCountRow = db.get('SELECT COUNT(*) as cnt FROM message_vectors') as Record<string, unknown>;
  const vectorCount = vecCountRow.cnt as number;

  log(`\n--- Search: "${query}" ---`);
  log(`  Vectors in DB: ${fmt(vectorCount)}`);

  if (opts.compare) {
    // ── FTS5-only ───────────────────────────────────────────────────
    const stopFts = perf();
    const ftsResults = searchMessagesFts(query, opts.searchLimit, opts.projectId);
    const ftsMs = stopFts();

    // ── Dual-path ───────────────────────────────────────────────────
    const stopDual = perf();
    const dualResults = await dualPathSearch(query, {
      limit: opts.searchLimit,
      projectId: opts.projectId,
    });
    const dualMs = stopDual();

    log(`  FTS5 search: ${fmtMs(ftsMs)} (${ftsResults.length} results)`);
    log(`  Dual-path:   ${fmtMs(dualMs)} (${dualResults.length} results, ${fmt(vectorCount)} vectors scanned)`);

    printResults(`FTS5-only (${fmtMs(ftsMs)})`, ftsResults);
    printResults(`Dual-path (${fmtMs(dualMs)})`, dualResults);

    // Show what semantic search added
    const ftsIds = new Set(ftsResults.map(r => r.message_id));
    const semanticOnly = dualResults.filter(r => !ftsIds.has(r.message_id));
    if (semanticOnly.length > 0) {
      printResults('Semantic-only additions', semanticOnly);
    } else {
      log('\n  Semantic search found no additional results beyond FTS5.');
    }
  } else {
    // ── Standard dual-path search ───────────────────────────────────
    const stopSearch = perf();
    const results = await dualPathSearch(query, {
      limit: opts.searchLimit,
      projectId: opts.projectId,
    });
    const searchMs = stopSearch();

    log(`  Total: ${fmtMs(searchMs)} (${fmt(vectorCount)} vectors scanned)`);

    printResults(`Dual-path results (${fmtMs(searchMs)})`, results);
  }
}

// ============================================================================
// Stats
// ============================================================================

function printStats(): void {
  const db = getDb(dbPath());

  const msgRow = db.get('SELECT COUNT(*) as cnt FROM messages') as Record<string, unknown>;
  const vecRow = db.get('SELECT COUNT(*) as cnt FROM message_vectors') as Record<string, unknown>;
  const sessionRow = db.get('SELECT COUNT(DISTINCT session_id) as cnt FROM messages') as Record<string, unknown>;
  const vecSessionRow = db.get(`
    SELECT COUNT(DISTINCT m.session_id) as cnt
    FROM message_vectors mv JOIN messages m ON m.message_id = mv.message_id
  `) as Record<string, unknown>;

  log('\n--- Database Stats ---');
  log(`  Messages indexed:     ${fmt(msgRow.cnt as number)} across ${fmt(sessionRow.cnt as number)} sessions`);
  log(`  Messages embedded:    ${fmt(vecRow.cnt as number)} across ${fmt(vecSessionRow.cnt as number)} sessions`);
  log(`  Coverage:             ${((vecRow.cnt as number) / Math.max(1, msgRow.cnt as number) * 100).toFixed(1)}%`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const opts = parseCli();
  if (!opts) process.exit(0);

  // Preflight
  const dbFile = dbPath();
  if (!existsSync(dbFile)) {
    log(`Error: Database not found at ${dbFile}`);
    process.exit(1);
  }

  // Bootstrap
  const stopBootstrap = perf();
  const cwd = process.cwd();
  const dispatch = createAgentDispatch();
  const unregister = registerAllAdapters({ cwd, hostType: 'dev-server', dispatch });
  await initSettings({ cwd });
  log(`[recall-embed-test] Bootstrap: ${fmtMs(stopBootstrap())}`);

  const shutdown = () => {
    dispatch.dispose();
    unregister();
  };

  process.on('SIGINT', () => {
    log('\n[recall-embed-test] Interrupted');
    shutdown();
    process.exit(130);
  });

  try {
    const stopTotal = perf();

    // Backfill
    const { indexed, embedded } = await runBackfill(opts);

    // Stats
    printStats();

    if (opts.backfillOnly) {
      log(`\nBackfill complete: ${fmt(indexed)} messages indexed, ${fmt(embedded)} messages embedded (${fmtMs(stopTotal())})`);
    } else if (opts.query) {
      await runSearch(opts.query, opts);
      log(`\nTotal wall time: ${fmtMs(stopTotal())}`);
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error('[recall-embed-test] Fatal error:', err);
  process.exit(1);
});
