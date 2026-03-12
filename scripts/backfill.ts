/**
 * Backfill CLI — Run Rosie's summarize and tracker pipelines on historical sessions
 *
 * Bootstraps the adapter system (same as dev-server), then uses production
 * code to process old sessions through the summarize → tracker chain.
 *
 * Supports concurrent dispatch (--concurrency / -c) to parallelize LLM calls.
 * Summarize is embarrassingly parallel; tracker batches refresh project context
 * between waves to avoid stale matches.
 *
 * Usage:
 *   npx tsx scripts/backfill.ts summarize [options]
 *   npx tsx scripts/backfill.ts track [options]
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
import { createAgentDispatch } from '../src/host/agent-dispatch.js';
import { registerAllAdapters, resolveInternalServerPaths } from '../src/host/adapter-registry.js';
import { initSettings } from '../src/core/settings/index.js';
import { parseModelOption } from '../src/core/model-utils.js';
import { appendActivityEntries, dbPath } from '../src/core/activity-index.js';
import { listAllSessions, loadSession } from '../src/core/session-manager.js';
import { extractTag, normalizeEntitiesJson } from '../src/core/rosie/xml-utils.js';
import { SUMMARIZE_PROMPT, buildTrackerPrompt } from '../src/core/rosie/rosie-bot-hook.js';
import { getExistingProjects } from '../src/core/rosie/tracker/db-writer.js';
import { buildInternalMcpConfig } from '../src/mcp/servers/external.js';
import { getDb } from '../src/core/crispy-db.js';
import { stripToolContent } from '../src/core/recall/transcript-utils.js';
import { ingestSessionMessages } from '../src/core/recall/message-ingest.js';
import { hasSessionMessages, insertMessageVectors } from '../src/core/recall/message-store.js';
import type { MessageVectorRecord } from '../src/core/recall/message-store.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_CONCURRENCY = 1;

// ============================================================================
// CLI Parsing
// ============================================================================

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/backfill.ts <command> [options]

Commands:
  summarize       Generate rosie-meta for sessions (paused for rework)
  track           Run tracker on rosie-meta entries (paused for rework)
  index           Populate the message-level FTS5 recall index
  embed-messages  Generate q8 embedding vectors for indexed messages

Options:
  --model, -m <vendor:model>   Model to use (default: ${DEFAULT_MODEL})
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
  command: 'summarize' | 'track' | 'index' | 'embed-messages';
  model: string;
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

  if (command !== 'summarize' && command !== 'track' && command !== 'index' && command !== 'embed-messages') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return null;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      model: { type: 'string', short: 'm', default: DEFAULT_MODEL },
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
    model: values.model as string,
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

/** Build a SQL filter clause for --workspace and --session flags. */
function buildFileFilter(workspace: string | undefined, session: string | undefined): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];

  if (workspace) {
    parts.push('file LIKE ?');
    params.push(`%${workspace}%`);
  }
  if (session) {
    parts.push('file LIKE ?');
    params.push(`%${session}%`);
  }

  return {
    clause: parts.length > 0 ? `AND ${parts.join(' AND ')}` : '',
    params,
  };
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
// Summarize Command
// ============================================================================

interface SummarizeCandidate {
  file: string;
  firstTs: string;
  turns: number;
}

function findSummarizeCandidates(workspace: string | undefined, session: string | undefined, limit: number): SummarizeCandidate[] {
  const db = getDb(dbPath());
  const filter = buildFileFilter(workspace, session);

  const rows = db.all(`
    SELECT DISTINCT file, MIN(timestamp) as first_ts, COUNT(*) as turns
    FROM activity_entries WHERE kind = 'prompt'
    AND file NOT IN (SELECT DISTINCT file FROM activity_entries WHERE kind = 'rosie-meta')
    ${filter.clause}
    GROUP BY file ORDER BY first_ts ASC LIMIT ?
  `, [...filter.params, limit]) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    file: r.file as string,
    firstTs: r.first_ts as string,
    turns: r.turns as number,
  }));
}

async function runSummarize(dispatch: ReturnType<typeof createAgentDispatch>, opts: CliOptions): Promise<void> {
  const candidates = findSummarizeCandidates(opts.workspace, opts.session, opts.limit);

  if (candidates.length === 0) {
    log('No sessions found without rosie-meta');
    return;
  }

  log(`Found ${candidates.length} session(s) to summarize (concurrency: ${opts.concurrency})`);

  const allSessions = listAllSessions();
  const sessionsByPath = new Map(allSessions.map((s) => [s.path, s]));

  const { vendor: modelVendor, model: modelName } = parseModelOption(opts.model);

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  const startTime = Date.now();

  await pooled(candidates, opts.concurrency, async (c, i) => {
    const label = `[${i + 1}/${candidates.length}]`;
    log(`\n${label} ${c.file}`);
    log(`  First prompt: ${c.firstTs} | Turns: ${c.turns}`);

    if (!existsSync(c.file)) {
      log('  SKIP — file not found on disk');
      skipCount++;
      return;
    }

    const sessionInfo = sessionsByPath.get(c.file);
    if (!sessionInfo) {
      log('  SKIP — no session found in adapter registry (adapter may not be registered)');
      skipCount++;
      return;
    }

    const vendor = modelVendor;
    const model = modelName || undefined;

    log(`  Session: ${sessionInfo.sessionId} | Parent: ${sessionInfo.vendor} | Child: ${vendor}:${model ?? 'default'}`);

    if (opts.dryRun) {
      result(JSON.stringify({
        action: 'summarize',
        dryRun: true,
        file: c.file,
        sessionId: sessionInfo.sessionId,
        vendor,
        model: model ?? 'default',
        turns: c.turns,
      }));
      return;
    }

    try {
      const t0 = Date.now();

      // Load full history, then strip tool content — keeps only user/assistant text blocks.
      // Even 36MB sessions compress to ~36KB since tool outputs dominate transcript size.
      const fullHistory = await loadSession(sessionInfo.sessionId);
      const filtered = stripToolContent(fullHistory);
      log(`  History: ${fullHistory.length} → ${filtered.length} entries`);

      const childResult = await dispatch.dispatchChild({
        parentSessionId: sessionInfo.sessionId,
        vendor,
        parentVendor: sessionInfo.vendor,
        prompt: SUMMARIZE_PROMPT,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        hydratedHistory: filtered,
        skipPersistSession: true,
        autoClose: true,
        timeoutMs: 60_000,
      });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!childResult) {
        log(`  FAIL — null response (${elapsed}s)`);
        failCount++;
        return;
      }

      if (opts.verbose) {
        log(`  Response (${childResult.text.length} chars): ${childResult.text.slice(0, 500)}`);
      }

      const fields = parseSummarizeResponse(childResult.text);
      if (!fields) {
        log(`  FAIL — parse error (${elapsed}s): ${childResult.text.slice(0, 200)}`);
        failCount++;
        return;
      }

      appendActivityEntries([{
        timestamp: new Date().toISOString(),
        kind: 'rosie-meta',
        file: c.file,
        preview: fields.quest,
        offset: 0,
        quest: fields.quest,
        summary: fields.summary,
        title: fields.title,
        status: fields.status,
        entities: fields.entities,
      }]);

      result(JSON.stringify({
        action: 'summarize',
        file: c.file,
        title: fields.title,
        quest: fields.quest,
        status: fields.status,
        entitiesCount: JSON.parse(fields.entities || '[]').length,
      }));

      okCount++;
      log(`  OK (${elapsed}s) — "${fields.title}"`);
    } catch (err) {
      failCount++;
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, (waveEnd) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (okCount / (Date.now() - startTime) * 1000 * 60).toFixed(1);
    log(`\n--- Wave complete (${waveEnd}/${candidates.length}) | OK: ${okCount} | Fail: ${failCount} | Skip: ${skipCount} | ${elapsed}s elapsed | ~${rate}/min ---`);
  });

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\n=== Summarize complete: ${okCount} OK, ${failCount} failed, ${skipCount} skipped in ${totalElapsed}s ===`);
}

function parseSummarizeResponse(text: string): {
  quest: string;
  title: string;
  summary: string;
  status: string;
  entities: string;
} | null {
  const quest = extractTag(text, 'goal');
  const title = extractTag(text, 'title');
  const summary = extractTag(text, 'summary');
  const status = extractTag(text, 'status');
  const entities = normalizeEntitiesJson(extractTag(text, 'entities'));

  if (quest && summary) return { quest, title, summary, status, entities };
  return null;
}

// ============================================================================
// Track Command
// ============================================================================

interface TrackCandidate {
  file: string;
  timestamp: string;
  quest: string;
  title: string;
  summary: string;
  status: string;
  entities: string;
}

/**
 * Find rosie-meta entries not yet tracked. Uses tracker_outcomes as the
 * authoritative "already processed" marker — not project_sessions, since
 * trivial entries are recorded in tracker_outcomes but never linked to a project.
 */
function findTrackCandidates(workspace: string | undefined, session: string | undefined, limit: number): TrackCandidate[] {
  const db = getDb(dbPath());
  const filter = buildFileFilter(workspace, session);

  const rows = db.all(`
    SELECT rowid, timestamp, file, quest, title, summary, status, entities
    FROM activity_entries
    WHERE kind = 'rosie-meta'
    AND file NOT IN (SELECT session_file FROM tracker_outcomes)
    ${filter.clause}
    ORDER BY timestamp ASC LIMIT ?
  `, [...filter.params, limit]) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    file: r.file as string,
    timestamp: r.timestamp as string,
    quest: (r.quest as string) ?? '',
    title: (r.title as string) ?? '',
    summary: (r.summary as string) ?? '',
    status: (r.status as string) ?? '',
    entities: (r.entities as string) ?? '[]',
  }));
}

async function runTrack(dispatch: ReturnType<typeof createAgentDispatch>, opts: CliOptions): Promise<void> {
  const candidates = findTrackCandidates(opts.workspace, opts.session, opts.limit);

  if (candidates.length === 0) {
    log('No untracked rosie-meta entries found');
    return;
  }

  log(`Found ${candidates.length} rosie-meta entry/entries to track (concurrency: ${opts.concurrency})`);

  const allSessions = listAllSessions();
  const sessionsByPath = new Map(allSessions.map((s) => [s.path, s]));

  const { vendor: modelVendor, model: modelName } = parseModelOption(opts.model);
  const serverPaths = resolveInternalServerPaths();

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  const startTime = Date.now();

  // Cache existing projects; refresh between waves for tracker accuracy
  let cachedProjects = getExistingProjects();

  await pooled(candidates, opts.concurrency, async (c, i) => {
    const label = `[${i + 1}/${candidates.length}]`;
    log(`\n${label} ${c.file}`);
    log(`  Title: ${c.title} | Quest: ${c.quest.slice(0, 80)}`);

    if (!existsSync(c.file)) {
      log('  SKIP — file not found on disk');
      skipCount++;
      return;
    }

    const sessionInfo = sessionsByPath.get(c.file);
    if (!sessionInfo) {
      log('  SKIP — no session found in adapter registry');
      skipCount++;
      return;
    }

    const vendor = modelVendor;
    const model = modelName;

    const prompt = buildTrackerPrompt(
      { quest: c.quest, title: c.title, summary: c.summary, status: c.status },
      cachedProjects,
    );

    log(`  Session: ${sessionInfo.sessionId} | Projects: ${cachedProjects.length} | ${vendor}:${model}`);

    if (opts.dryRun) {
      result(JSON.stringify({
        action: 'track',
        dryRun: true,
        file: c.file,
        sessionId: sessionInfo.sessionId,
        title: c.title,
        quest: c.quest,
        existingProjects: cachedProjects.length,
        promptLength: prompt.length,
      }));
      return;
    }

    try {
      const t0 = Date.now();
      const childResult = await dispatch.dispatchChild({
        parentSessionId: sessionInfo.sessionId,
        vendor,
        parentVendor: sessionInfo.vendor,
        prompt,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        forceNew: true,
        mcpServers: buildInternalMcpConfig(serverPaths.command, serverPaths.args, [
          `--session-file=${c.file}`,
        ]),
        env: {
          CLAUDECODE: '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
        },
        skipPersistSession: true,
        autoClose: true,
        timeoutMs: 60_000,
      });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!childResult) {
        log(`  FAIL — null response (${elapsed}s)`);
        failCount++;
        return;
      }

      if (opts.verbose) {
        log(`  Response (${childResult.text.length} chars): ${childResult.text.slice(0, 500)}`);
      }

      result(JSON.stringify({
        action: 'track',
        file: c.file,
        title: c.title,
        responseLength: childResult.text.length,
      }));

      okCount++;
      log(`  OK (${elapsed}s) — tracker completed`);
    } catch (err) {
      failCount++;
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, (waveEnd) => {
    // Refresh project cache between waves — new projects created in this wave
    // need to be visible to the next wave for accurate matching
    cachedProjects = getExistingProjects();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = okCount > 0 ? (okCount / (Date.now() - startTime) * 1000 * 60).toFixed(1) : '0';
    log(`\n--- Wave complete (${waveEnd}/${candidates.length}) | OK: ${okCount} | Fail: ${failCount} | Skip: ${skipCount} | ${elapsed}s elapsed | ~${rate}/min | Projects: ${cachedProjects.length} ---`);
  });

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\n=== Track complete: ${okCount} OK, ${failCount} failed, ${skipCount} skipped in ${totalElapsed}s ===`);
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
    // Join to activity_entries or session path — filter by session_id containing workspace
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

      // ONNX Runtime leaks internal state beyond what tensor.dispose()
      // can reclaim. Release the entire pipeline after each session to
      // keep RSS bounded. The ~2-5s reload cost per session is the price
      // of stability on memory-constrained environments (WSL2).
      await disposeFn!();
      tryGc();
    } catch (err) {
      failCount++;
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

  log(`[backfill] Ready — command: ${opts.command}, model: ${opts.model}, concurrency: ${opts.concurrency}, limit: ${opts.limit}${opts.workspace ? `, workspace: ${opts.workspace}` : ''}${opts.session ? `, session: ${opts.session}` : ''}${opts.dryRun ? ' (dry-run)' : ''}`);

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
    if (opts.command === 'summarize') {
      log(`Summarize is paused for rework. Use 'index' to populate the message-level FTS5 index.`);
    } else if (opts.command === 'track') {
      log(`Track is paused for rework. Use 'index' to populate the message-level FTS5 index.`);
    } else if (opts.command === 'index') {
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
