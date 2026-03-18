/**
 * Backfill CLI — Run recall indexing and embedding pipelines on historical sessions
 *
 * Bootstraps the adapter system (same as dev-server), then uses production
 * code to process old sessions through the index → embed chain.
 *
 * Supports concurrent dispatch (--concurrency / -c) to parallelize work.
 *
 * Usage:
 *   npx tsx scripts/backfill.ts index [options]
 *   npx tsx scripts/backfill.ts embed-messages [options]
 *
 * @module scripts/backfill
 */

// Unblock nested Claude sessions — backfill is often launched from inside
// Claude Code which sets CLAUDECODE=1, blocking child Claude processes.
delete process.env.CLAUDECODE;

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { registerAllAdapters } from '../src/host/adapter-registry.js';
import { createAgentDispatch } from '../src/host/agent-dispatch.js';
import { initSettings } from '../src/core/settings/index.js';
import { dbPath } from '../src/core/activity-index.js';
import { listAllSessions } from '../src/core/session-manager.js';
import { getDb } from '../src/core/crispy-db.js';
import { ingestSessionMessages } from '../src/core/recall/message-ingest.js';
import { hasSessionMessages, insertMessageVectors } from '../src/core/recall/message-store.js';
import type { MessageVectorRecord } from '../src/core/recall/message-store.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONCURRENCY = 1;

// ============================================================================
// CLI Parsing
// ============================================================================

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/backfill.ts <command> [options]

Commands:
  index           Populate the message-level FTS5 recall index
  embed-messages  Generate q8 embedding vectors for indexed messages

Options:
  --concurrency, -c <n>        Parallel dispatches (default: ${DEFAULT_CONCURRENCY})
  --workspace, -w <name>       Filter by workspace path substring
  --session, -s <id>           Target a specific session by ID or file path substring
  --limit, -l <n>              Process at most N sessions (default: 1)
  --days, -d <n>               Limit to sessions from the last N days (default: 3, embed-messages only)
  --dry-run                    Show what would happen without writing
  --verbose                    Print extra debug info
  --force                      Re-process already-processed sessions
  --help, -h                   Show this help

Examples:
  # Index 500 sessions into FTS5
  npx tsx scripts/backfill.ts index -l 500

  # Embed messages from the last 3 days (default)
  npx tsx scripts/backfill.ts embed-messages -l 50

  # Embed messages from the last 7 days
  npx tsx scripts/backfill.ts embed-messages -l 100 --days 7

  # Re-embed a specific session
  npx tsx scripts/backfill.ts embed-messages -s abc123 --force

  # Dry-run: see what would be processed
  npx tsx scripts/backfill.ts embed-messages -l 10 --dry-run
`);
}

interface CliOptions {
  command: 'index' | 'embed-messages';
  concurrency: number;
  workspace: string | undefined;
  session: string | undefined;
  limit: number;
  days: number;
  dryRun: boolean;
  verbose: boolean;
  force: boolean;
}

function parseCli(): CliOptions | null {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return null;
  }

  if (command !== 'index' && command !== 'embed-messages') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return null;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      concurrency: { type: 'string', short: 'c', default: String(DEFAULT_CONCURRENCY) },
      workspace: { type: 'string', short: 'w' },
      session: { type: 'string', short: 's' },
      limit: { type: 'string', short: 'l', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      days: { type: 'string', short: 'd', default: '3' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return null;
  }

  return {
    command: command as CliOptions['command'],
    concurrency: Math.max(1, parseInt(values.concurrency as string, 10) || DEFAULT_CONCURRENCY),
    workspace: values.workspace as string | undefined,
    session: values.session as string | undefined,
    limit: parseInt(values.limit as string, 10) || 1,
    days: Math.max(1, parseInt(values.days as string, 10) || 3),
    dryRun: values['dry-run'] as boolean,
    verbose: values.verbose as boolean,
    force: values.force as boolean,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function log(msg: string): void {
  console.error(msg);
}

function result(msg: string): void {
  console.log(msg);
}

// ============================================================================
// Concurrency Pool
// ============================================================================

/**
 * Run async tasks with bounded concurrency. Processes items in waves of N,
 * calling onWaveComplete between waves for state refresh.
 */
async function pooled<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  onWaveComplete?: (waveEnd: number) => void,
): Promise<void> {
  for (let start = 0; start < items.length; start += concurrency) {
    const wave = items.slice(start, start + concurrency);
    await Promise.all(wave.map((item, j) => fn(item, start + j)));
    onWaveComplete?.(start + wave.length);
  }
}

// ============================================================================
// Embed Messages Command
// ============================================================================

/** Max characters to embed per message (Nomic has 8192 token limit, ~4 chars/token). */
const MAX_EMBED_CHARS = 32_000;

interface EmbedMessagesCandidate {
  sessionId: string;
  messageCount: number;
}

/**
 * Find sessions that have messages indexed but no vectors yet.
 * Filtered by --days (created_at), ordered reverse-chronologically.
 */
function findEmbedMessagesCandidates(
  opts: CliOptions,
): EmbedMessagesCandidate[] {
  const db = getDb(dbPath());
  const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000;

  const params: (string | number)[] = [cutoff];
  let extraClauses = '';

  if (opts.workspace) {
    extraClauses += 'AND m.session_id LIKE ? ';
    params.push(`%${opts.workspace}%`);
  }
  if (opts.session) {
    extraClauses += 'AND m.session_id LIKE ? ';
    params.push(`%${opts.session}%`);
  }

  params.push(opts.limit);

  // Find sessions with messages but no vectors (unless --force)
  const skipClause = opts.force
    ? ''
    : `AND m.session_id NOT IN (
         SELECT DISTINCT m2.session_id FROM messages m2
         JOIN message_vectors mv ON mv.message_id = m2.message_id
       )`;

  const rows = db.all(`
    SELECT m.session_id, COUNT(*) as msg_count
    FROM messages m
    WHERE m.created_at >= ?
      ${extraClauses}
      ${skipClause}
    GROUP BY m.session_id
    ORDER BY MAX(m.created_at) DESC
    LIMIT ?
  `, params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    sessionId: r.session_id as string,
    messageCount: r.msg_count as number,
  }));
}

/** RSS threshold (in MB) at which we stop gracefully and let the wrapper
 *  restart us. The command is incremental so progress is preserved.
 *  Set above the typical post-dispose baseline (~800MB) but below the
 *  --max-old-space-size cap (1536MB) used by embed-robust.sh. */
const RSS_LIMIT_MB = 1280;

/** Check RSS and return true if we should stop to avoid OOM. */
function memoryPressure(): { rss: number; stop: boolean } {
  const rss = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  return { rss, stop: rss > RSS_LIMIT_MB };
}

/** Try to trigger GC if --expose-gc was passed. */
function tryGc(): void {
  if (typeof globalThis.gc === 'function') globalThis.gc();
}

async function runEmbedMessages(opts: CliOptions): Promise<void> {
  const candidates = findEmbedMessagesCandidates(opts);

  if (candidates.length === 0) {
    log('No sessions found to embed (all already vectorized or no messages in range)');
    return;
  }

  const totalMessages = candidates.reduce((sum, c) => sum + c.messageCount, 0);
  log(`Found ${candidates.length} session(s) with ${totalMessages} messages to embed (days: ${opts.days}${opts.force ? ', force' : ''})`);

  // Lazy-load embedding modules
  let embedBatchFn: ((texts: string[]) => Promise<Float32Array[]>) | null = null;
  let disposeFn: (() => Promise<void>) | null = null;
  let quantizeFn: ((f32: Float32Array) => { q8: Int8Array; scale: number }) | null = null;
  let normFn: ((f32: Float32Array) => number) | null = null;

  try {
    const { embedBatch, disposeEmbedder } = await import('../src/core/recall/embedder.js');
    const { quantizeToQ8, computeNorm } = await import('../src/core/recall/quantize.js');
    embedBatchFn = embedBatch;
    disposeFn = disposeEmbedder;
    quantizeFn = quantizeToQ8;
    normFn = computeNorm;
  } catch (err) {
    log(`FATAL — Failed to load embedding model: ${err instanceof Error ? err.message : String(err)}`);
    log('Ensure @huggingface/transformers is installed and network access is available for model download.');
    return;
  }

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let totalEmbedded = 0;
  const startTime = Date.now();
  const db = getDb(dbPath());

  for (let i = 0; i < candidates.length; i++) {
    // Memory watchdog — exit gracefully if RSS is too high.
    // Progress is preserved (incremental), so re-running picks up here.
    const mem = memoryPressure();
    if (mem.stop) {
      log(`\n⚠ RSS ${mem.rss}MB exceeds ${RSS_LIMIT_MB}MB limit — stopping to avoid OOM.`);
      log(`  Progress is saved. Re-run to continue from where we left off.`);
      break;
    }

    const c = candidates[i]!;
    const label = `[${i + 1}/${candidates.length}]`;
    log(`\n${label} ${c.sessionId} (${c.messageCount} msgs, RSS: ${mem.rss}MB)`);

    if (opts.dryRun) {
      result(JSON.stringify({
        action: 'embed-messages',
        dryRun: true,
        sessionId: c.sessionId,
        messageCount: c.messageCount,
      }));
      continue;
    }

    try {
      const t0 = Date.now();

      // Read all messages for this session
      const rows = db.all(
        `SELECT message_id, message_text FROM messages
         WHERE session_id = ? ORDER BY message_seq ASC`,
        [c.sessionId],
      ) as Array<Record<string, unknown>>;

      // Filter out empty messages and prepare texts
      const validRows: Array<{ messageId: string; text: string }> = [];
      for (const r of rows) {
        const text = (r.message_text as string).trim();
        if (!text) continue;
        const truncated = text.length > MAX_EMBED_CHARS;
        if (truncated && opts.verbose) {
          log(`  WARN — message ${r.message_id} truncated (${text.length} chars → ${MAX_EMBED_CHARS})`);
        }
        validRows.push({
          messageId: r.message_id as string,
          text: truncated ? text.slice(0, MAX_EMBED_CHARS) : text,
        });
      }

      if (validRows.length === 0) {
        log('  SKIP — no embeddable messages');
        skipCount++;
        continue;
      }

      // Embed in batch (embedBatch internally sub-batches to MAX_BATCH_SIZE)
      const texts = validRows.map(r => r.text);
      const vectors = await embedBatchFn!(texts);

      // Quantize and build records
      const records: MessageVectorRecord[] = [];
      for (let j = 0; j < validRows.length; j++) {
        const f32 = vectors[j]!;
        const { q8, scale } = quantizeFn!(f32);
        const norm = normFn!(f32);
        records.push({
          messageId: validRows[j]!.messageId,
          embeddingQ8: q8,
          norm,
          quantScale: scale,
        });
      }

      // Batch insert
      insertMessageVectors(records);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      totalEmbedded += records.length;
      okCount++;
      log(`  OK (${elapsed}s) — ${records.length} messages embedded`);

      result(JSON.stringify({
        action: 'embed-messages',
        sessionId: c.sessionId,
        embedded: records.length,
        elapsed: parseFloat(elapsed),
      }));

      tryGc();
    } catch (err) {
      failCount++;
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Clean up server if running — don't rely on idle timer since process is about to exit
  await disposeFn?.();

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\n=== Embed-messages complete: ${okCount} OK, ${failCount} failed, ${skipCount} skipped, ${totalEmbedded} messages embedded in ${totalElapsed}s ===`);
}

// ============================================================================
// Index Command
// ============================================================================

interface IndexCandidate {
  sessionId: string;
  size: number;
}

/**
 * Find sessions eligible for message-level indexing. Uses the adapter registry
 * to discover sessions, then filters out sessions that already have messages
 * in the DB (unless --force).
 */
function findIndexCandidates(
  workspace: string | undefined,
  session: string | undefined,
  limit: number,
  force: boolean,
): IndexCandidate[] {
  const allSessions = listAllSessions();
  const candidates: IndexCandidate[] = [];

  for (const s of allSessions) {
    if (s.isSidechain) continue;
    if (workspace && !s.path.includes(workspace)) continue;
    if (session && !s.path.includes(session) && !s.sessionId.includes(session)) continue;
    if (!existsSync(s.path)) continue;

    // Skip already-processed sessions unless --force
    if (!force && hasSessionMessages(s.sessionId)) continue;

    candidates.push({
      sessionId: s.sessionId,
      size: s.size,
    });

    if (candidates.length >= limit) break;
  }

  return candidates;
}

async function runIndex(opts: CliOptions): Promise<void> {
  const candidates = findIndexCandidates(opts.workspace, opts.session, opts.limit, opts.force);

  if (candidates.length === 0) {
    log('No sessions found to index');
    return;
  }

  log(`Found ${candidates.length} session(s) to index (concurrency: ${opts.concurrency}${opts.force ? ', force' : ''})`);

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let totalMessages = 0;
  const startTime = Date.now();

  await pooled(candidates, opts.concurrency, async (c, i) => {
    const label = `[${i + 1}/${candidates.length}]`;
    const sizeKb = (c.size / 1024).toFixed(0);
    log(`\n${label} ${c.sessionId} (${sizeKb} KB)`);

    if (opts.dryRun) {
      result(JSON.stringify({
        action: 'index',
        dryRun: true,
        sessionId: c.sessionId,
        sizeBytes: c.size,
      }));
      return;
    }

    try {
      const t0 = Date.now();

      const ingestResult = await ingestSessionMessages(c.sessionId, {
        force: opts.force,
        verbose: opts.verbose,
      });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (ingestResult.error) {
        log(`  FAIL — ${ingestResult.error} (${elapsed}s)`);
        failCount++;
        return;
      }

      if (ingestResult.skipped) {
        log(`  SKIP — already processed or no content`);
        skipCount++;
        return;
      }

      totalMessages += ingestResult.chunksCreated;
      okCount++;
      log(`  OK (${elapsed}s) — ${ingestResult.chunksCreated} messages`);

      result(JSON.stringify({
        action: 'index',
        sessionId: c.sessionId,
        messages: ingestResult.chunksCreated,
      }));
    } catch (err) {
      failCount++;
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, (waveEnd) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = okCount > 0 ? (okCount / (Date.now() - startTime) * 1000 * 60).toFixed(1) : '0';
    log(`\n--- Wave complete (${waveEnd}/${candidates.length}) | OK: ${okCount} | Fail: ${failCount} | Skip: ${skipCount} | Messages: ${totalMessages} | ${elapsed}s elapsed | ~${rate}/min ---`);
  });

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\n=== Index complete: ${okCount} OK, ${failCount} failed, ${skipCount} skipped, ${totalMessages} messages in ${totalElapsed}s ===`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const opts = parseCli();
  if (!opts) process.exit(0);

  log(`[backfill] Bootstrapping adapter system...`);

  const cwd = process.cwd();
  const dispatch = createAgentDispatch();
  const unregister = registerAllAdapters({ cwd, hostType: 'dev-server', dispatch });
  await initSettings({ cwd });

  log(`[backfill] Ready — command: ${opts.command}, concurrency: ${opts.concurrency}, limit: ${opts.limit}${opts.workspace ? `, workspace: ${opts.workspace}` : ''}${opts.session ? `, session: ${opts.session}` : ''}${opts.dryRun ? ' (dry-run)' : ''}`);

  const shutdown = () => {
    log('\n[backfill] Shutting down...');
    dispatch.dispose();
    unregister();
    log('[backfill] Done');
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });

  try {
    if (opts.command === 'index') {
      await runIndex(opts);
    } else if (opts.command === 'embed-messages') {
      await runEmbedMessages(opts);
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
