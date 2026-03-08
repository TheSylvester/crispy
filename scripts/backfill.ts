/**
 * Backfill CLI — Run Rosie's summarize and tracker pipelines on historical sessions
 *
 * Bootstraps the adapter system (same as dev-server), then uses production
 * code to process old sessions through the summarize → tracker chain.
 *
 * Usage:
 *   npx tsx scripts/backfill.ts summarize [options]
 *   npx tsx scripts/backfill.ts track [options]
 *
 * @module scripts/backfill
 */

// Unblock nested Claude sessions — backfill is often launched from inside
// Claude Code which sets CLAUDECODE=1, blocking child Claude processes.
delete process.env.CLAUDECODE;

import { parseArgs } from 'node:util';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createAgentDispatch } from '../src/host/agent-dispatch.js';
import { registerAllAdapters, resolveInternalServerPaths } from '../src/host/adapter-registry.js';
import { initSettings } from '../src/core/settings/index.js';
import { parseModelOption } from '../src/core/model-utils.js';
import { appendActivityEntries, dbPath } from '../src/core/activity-index.js';
import { listAllSessions } from '../src/core/session-manager.js';
import { extractTag, normalizeEntitiesJson } from '../src/core/rosie/xml-utils.js';
import { SUMMARIZE_PROMPT } from '../src/core/rosie/summarize-hook.js';
import { buildTrackerPrompt } from '../src/core/rosie/tracker/tracker-hook.js';
import { getExistingProjects } from '../src/core/rosie/tracker/db-writer.js';
import { buildInternalMcpConfig } from '../src/mcp/servers/external.js';
import { getDb } from '../src/core/crispy-db.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Conservative file-size threshold for fork mode. 2.1MB worked, 2.6MB didn't — use 2MB. */
const MAX_FORK_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// ============================================================================
// CLI Parsing
// ============================================================================

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/backfill.ts <command> [options]

Commands:
  summarize    Generate rosie-meta for sessions that don't have it
  track        Run tracker on rosie-meta entries not yet tracked

Options:
  --model, -m <vendor:model>   Model to use (default: ${DEFAULT_MODEL})
  --workspace, -w <name>       Filter by workspace path substring
  --session, -s <id>           Target a specific session by ID or file path substring
  --limit, -l <n>              Process at most N entries (default: 1)
  --dry-run                    Show what would happen without writing
  --verbose                    Print extra debug info
  --help, -h                   Show this help

Examples:
  # Summarize the oldest unsummarized crispy session
  npx tsx scripts/backfill.ts summarize -w crispy

  # Summarize a specific session with zai
  npx tsx scripts/backfill.ts summarize -s 59db280a -m zai:GLM-4.7

  # Track the next untracked entry with haiku
  npx tsx scripts/backfill.ts track -w crispy

  # Track a specific session
  npx tsx scripts/backfill.ts track -s cb4132ca -m zai:GLM-4.7

  # Dry-run: see what would be processed
  npx tsx scripts/backfill.ts summarize -w crispy -l 10 --dry-run
`);
}

interface CliOptions {
  command: 'summarize' | 'track';
  model: string;
  workspace: string | undefined;
  session: string | undefined;
  limit: number;
  dryRun: boolean;
  verbose: boolean;
}

function parseCli(): CliOptions | null {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return null;
  }

  if (command !== 'summarize' && command !== 'track') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return null;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      model: { type: 'string', short: 'm', default: DEFAULT_MODEL },
      workspace: { type: 'string', short: 'w' },
      session: { type: 'string', short: 's' },
      limit: { type: 'string', short: 'l', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return null;
  }

  return {
    command: command as 'summarize' | 'track',
    model: values.model as string,
    workspace: values.workspace as string | undefined,
    session: values.session as string | undefined,
    limit: parseInt(values.limit as string, 10) || 1,
    dryRun: values['dry-run'] as boolean,
    verbose: values.verbose as boolean,
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
// Oversized Session Fallback
// ============================================================================

function isOversized(filePath: string): boolean {
  try {
    return statSync(filePath).size > MAX_FORK_FILE_SIZE;
  } catch {
    return false;
  }
}

interface RosieMetaEntry {
  timestamp: string;
  quest: string;
  title: string;
  summary: string;
  status: string;
}

/** Fetch existing rosie-meta entries for a session file, ordered chronologically. */
function getExistingRosieMetas(file: string): RosieMetaEntry[] {
  const db = getDb(dbPath());
  const rows = db.all(`
    SELECT timestamp, quest, title, summary, status
    FROM activity_entries
    WHERE kind = 'rosie-meta' AND file = ?
    ORDER BY timestamp ASC
  `, [file]) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    timestamp: (r.timestamp as string) ?? '',
    quest: (r.quest as string) ?? '',
    title: (r.title as string) ?? '',
    summary: (r.summary as string) ?? '',
    status: (r.status as string) ?? '',
  }));
}

interface BookendTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Extract the first N and last M user/assistant turns from a JSONL transcript.
 * Gives the model the conversation's opening (original ask) and ending (final state).
 */
function extractBookendTurns(
  filePath: string,
  firstN: number = 2,
  lastM: number = 2,
): { first: BookendTurn[]; last: BookendTurn[] } {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);

  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  // Filter to user/assistant message entries (skip system, meta, tool results, etc.)
  const messageTurns = entries.filter(
    (e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.toolUseResult,
  );

  const first = messageTurns.slice(0, firstN).map(summarizeTurn);
  const last = messageTurns.length > firstN
    ? messageTurns.slice(-lastM).map(summarizeTurn)
    : [];
  return { first, last };
}

const MAX_TURN_CHARS = 4000;

function summarizeTurn(entry: Record<string, unknown>): BookendTurn {
  const role = entry.type === 'user' ? 'user' as const : 'assistant' as const;
  let content = '';

  const msg = entry.message as { content?: unknown } | undefined;
  if (typeof msg?.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg?.content)) {
    content = (msg.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');
  }

  if (content.length > MAX_TURN_CHARS) {
    content = content.slice(0, MAX_TURN_CHARS) + '\n[...truncated]';
  }
  return { role, content };
}

/** Assemble synthetic context + summarize prompt for oversized sessions. */
function buildFallbackPrompt(
  firstTurns: BookendTurn[],
  lastTurns: BookendTurn[],
  metas: RosieMetaEntry[],
): string {
  let context = 'You are summarizing a conversation that was too long to show in full.\n\n';

  context += '## Opening turns (verbatim)\n\n';
  for (const t of firstTurns) {
    context += `**${t.role}:** ${t.content}\n\n`;
  }

  if (metas.length > 0) {
    context += '## Intermediate turn summaries (from prior analysis)\n\n';
    for (const m of metas) {
      context += `- **${m.title}** — ${m.quest}\n  Status: ${m.status}\n\n`;
    }
  } else {
    context += '## Middle turns\n\n[No prior summaries available — middle of conversation omitted]\n\n';
  }

  context += '## Final turns (verbatim)\n\n';
  for (const t of lastTurns) {
    context += `**${t.role}:** ${t.content}\n\n`;
  }

  context += '---\n\nBased on the conversation above, produce the following analysis:\n\n';
  context += SUMMARIZE_PROMPT;

  return context;
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

  log(`Found ${candidates.length} session(s) to summarize`);

  const allSessions = listAllSessions();
  const sessionsByPath = new Map(allSessions.map((s) => [s.path, s]));

  const { vendor: modelVendor, model: modelName } = parseModelOption(opts.model);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    log(`\n[${i + 1}/${candidates.length}] ${c.file}`);
    log(`  First prompt: ${c.firstTs} | Turns: ${c.turns}`);

    if (!existsSync(c.file)) {
      log('  SKIP — file not found on disk');
      continue;
    }

    const sessionInfo = sessionsByPath.get(c.file);
    if (!sessionInfo) {
      log('  SKIP — no session found in adapter registry (adapter may not be registered)');
      continue;
    }

    // Summarize uses fork mode — child needs to see the full transcript.
    // dispatchChildSession routes by vendor match:
    // - Same vendor → native fork (e.g. zai forking claude — same CLI)
    // - Cross-vendor → hydrated fork (loads history, converts to universal format)
    // - forceNew → blank session (no transcript context)
    // Pass the session's actual vendor as parentVendor so cross-vendor hydration works.
    const vendor = modelVendor;
    const model = modelName || undefined;

    const oversized = isOversized(c.file);

    log(`  Session: ${sessionInfo.sessionId} | Parent vendor: ${sessionInfo.vendor} | Child vendor: ${vendor} | Model: ${model ?? 'default'}${oversized ? ' | OVERSIZED' : ''}`);

    if (opts.dryRun) {
      result(JSON.stringify({
        action: 'summarize',
        dryRun: true,
        file: c.file,
        sessionId: sessionInfo.sessionId,
        vendor,
        model: model ?? 'default',
        turns: c.turns,
        oversized,
        fallbackMode: oversized ? 'synthetic' : 'fork',
      }));
      continue;
    }

    try {
      let childResult;

      if (oversized) {
        const metas = getExistingRosieMetas(c.file);
        const { first, last } = extractBookendTurns(c.file);
        const prompt = buildFallbackPrompt(first, last, metas);

        log(`  OVERSIZED — using fallback (${first.length} first turns, ${metas.length} DB summaries, ${last.length} last turns)`);

        childResult = await dispatch.dispatchChild({
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
          skipPersistSession: true,
          autoClose: true,
          timeoutMs: 60_000,
        });
      } else {
        log('  Dispatching child session (fork)...');
        childResult = await dispatch.dispatchChild({
          parentSessionId: sessionInfo.sessionId,
          vendor,
          parentVendor: sessionInfo.vendor,
          prompt: SUMMARIZE_PROMPT,
          settings: {
            ...(model && { model }),
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          },
          skipPersistSession: true,
          autoClose: true,
          timeoutMs: 60_000,
        });
      }

      if (!childResult) {
        log('  FAIL — dispatchChild returned null (timeout or empty response)');
        continue;
      }

      if (opts.verbose) {
        log(`  Response (${childResult.text.length} chars): ${childResult.text.slice(0, 500)}`);
      }

      const fields = parseSummarizeResponse(childResult.text);
      if (!fields) {
        log(`  FAIL — could not parse response: ${childResult.text.slice(0, 200)}`);
        continue;
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

      log(`  OK — "${fields.title}"`);
    } catch (err) {
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

function findTrackCandidates(workspace: string | undefined, session: string | undefined, limit: number): TrackCandidate[] {
  const db = getDb(dbPath());
  const filter = buildFileFilter(workspace, session);

  const rows = db.all(`
    SELECT rowid, timestamp, file, quest, title, summary, status, entities
    FROM activity_entries
    WHERE kind = 'rosie-meta'
    AND file NOT IN (SELECT session_file FROM project_sessions)
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

  log(`Found ${candidates.length} rosie-meta entry/entries to track`);

  const allSessions = listAllSessions();
  const sessionsByPath = new Map(allSessions.map((s) => [s.path, s]));

  const { vendor: modelVendor, model: modelName } = parseModelOption(opts.model);
  const serverPaths = resolveInternalServerPaths();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    log(`\n[${i + 1}/${candidates.length}] ${c.file}`);
    log(`  Title: ${c.title} | Quest: ${c.quest.slice(0, 80)}`);

    if (!existsSync(c.file)) {
      log('  SKIP — file not found on disk');
      continue;
    }

    const sessionInfo = sessionsByPath.get(c.file);
    if (!sessionInfo) {
      log('  SKIP — no session found in adapter registry');
      continue;
    }

    const vendor = modelVendor;
    const model = modelName;

    const existingProjects = getExistingProjects();
    const prompt = buildTrackerPrompt(
      { quest: c.quest, title: c.title, summary: c.summary, status: c.status, entities: c.entities },
      existingProjects,
    );

    log(`  Session: ${sessionInfo.sessionId} | Projects in DB: ${existingProjects.length} | Dispatch via ${vendor}:${model}`);

    if (opts.dryRun) {
      result(JSON.stringify({
        action: 'track',
        dryRun: true,
        file: c.file,
        sessionId: sessionInfo.sessionId,
        title: c.title,
        quest: c.quest,
        existingProjects: existingProjects.length,
        promptLength: prompt.length,
      }));
      continue;
    }

    try {
      log('  Dispatching tracker child session...');
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

      if (!childResult) {
        log('  FAIL — dispatchChild returned null (timeout or empty response)');
        continue;
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

      log(`  OK — tracker completed`);
    } catch (err) {
      log(`  ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

  log(`[backfill] Ready — command: ${opts.command}, model: ${opts.model}, limit: ${opts.limit}${opts.workspace ? `, workspace: ${opts.workspace}` : ''}${opts.session ? `, session: ${opts.session}` : ''}${opts.dryRun ? ' (dry-run)' : ''}`);

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
      await runSummarize(dispatch, opts);
    } else {
      await runTrack(dispatch, opts);
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
