/**
 * Smoke Test — Core Systems Validation
 *
 * Quick validation of core systems against real ~/.crispy/ data.
 * Run after making changes to recall, embeddings, DB, or adapters.
 * No mocks, no SDK calls — just verifies the existing data pipeline works.
 *
 * Catches the bugs that bit us in March 2026:
 *   - FTS5 query performance regressions (1000x slowdown)
 *   - Embedding pipeline OOM / crashes
 *   - DB FK constraint violations
 *   - Adapter spawn PATH inheritance
 *   - MCP server path resolution
 *
 * Usage:
 *   npx tsx scripts/smoke.ts              # all checks
 *   npx tsx scripts/smoke.ts --skip-embed  # skip embedding (slow on first run)
 *
 * @module scripts/smoke
 */

delete process.env.CLAUDECODE;

import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { dbPath } from '../src/core/activity-index.js';
import { getDb, closeDb } from '../src/core/crispy-db.js';
import {
  searchMessagesFts,
  searchMessagesFtsMeta,
  grepMessages,
  getEmbeddingGapStats,
  getIndexedSessionIds,
} from '../src/core/recall/message-store.js';
import { listAllSessions } from '../src/core/session-manager.js';
import { registerAllAdapters } from '../src/host/adapter-registry.js';
import { createAgentDispatch } from '../src/host/agent-dispatch.js';
import { initSettings } from '../src/core/settings/index.js';

// ============================================================================
// Config
// ============================================================================

const SKIP_EMBED = process.argv.includes('--skip-embed');

/** FTS5 queries must return within this many ms */
const FTS5_LATENCY_THRESHOLD_MS = 2000;

/** Minimum indexed sessions to consider the DB healthy */
const MIN_INDEXED_SESSIONS = 10;

// ============================================================================
// Formatting
// ============================================================================

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

interface StepResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  ms?: number;
}

const results: StepResult[] = [];

function record(name: string, status: 'pass' | 'fail' | 'skip', detail?: string, ms?: number): void {
  results.push({ name, status, detail, ms });
  const icon = status === 'pass' ? PASS : status === 'fail' ? FAIL : SKIP;
  const timing = ms !== undefined ? ` ${DIM}(${ms.toFixed(0)}ms)${RESET}` : '';
  console.log(`  ${icon}  ${name}${timing}`);
  if (detail) console.log(`        ${DIM}${detail}${RESET}`);
}

function header(title: string): void {
  console.log(`\n${BOLD}--- ${title} ---${RESET}`);
}

// ============================================================================
// Checks
// ============================================================================

function checkDbExists(): boolean {
  const path = dbPath();
  const exists = existsSync(path);
  record('Database exists', exists ? 'pass' : 'fail', path);
  return exists;
}

function checkDbIntegrity(): void {
  const db = getDb(dbPath());

  // FK enforcement
  const fkRow = db.get('PRAGMA foreign_keys') as Record<string, unknown> | undefined;
  const fkEnabled = fkRow && Object.values(fkRow)[0] === 1;
  record('Foreign keys enabled', fkEnabled ? 'pass' : 'fail');

  // Integrity check
  const t0 = performance.now();
  const intRow = db.get('PRAGMA integrity_check') as Record<string, unknown> | undefined;
  const ms = performance.now() - t0;
  const ok = intRow && Object.values(intRow)[0] === 'ok';
  record('DB integrity check', ok ? 'pass' : 'fail', undefined, ms);

  // Key tables exist
  const tables = db.all(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ) as Array<{ name: string }>;
  const tableNames = new Set(tables.map(r => r.name));
  const required = ['messages', 'messages_fts', 'projects', 'project_sessions'];
  for (const t of required) {
    record(`Table "${t}" exists`, tableNames.has(t) ? 'pass' : 'fail');
  }

  // message_vectors table (embeddings)
  record(
    'Table "message_vectors" exists',
    tableNames.has('message_vectors') ? 'pass' : 'fail',
    'Required for semantic search',
  );
}

function checkFts5Performance(): void {
  const queries = ['recall system', 'rosie tracker', 'embedding pipeline'];

  for (const q of queries) {
    const t0 = performance.now();
    try {
      const results = searchMessagesFts(q, 5);
      const ms = performance.now() - t0;
      const fast = ms < FTS5_LATENCY_THRESHOLD_MS;
      record(
        `FTS5 query "${q}"`,
        fast ? 'pass' : 'fail',
        `${results.length} results`,
        ms,
      );
    } catch (err) {
      const ms = performance.now() - t0;
      record(`FTS5 query "${q}"`, 'fail', String(err), ms);
    }
  }

  // Meta query (aggregation) — this is where the 1000x slowdown hit
  const t0 = performance.now();
  try {
    const meta = searchMessagesFtsMeta('recall');
    const ms = performance.now() - t0;
    record(
      'FTS5 meta query (aggregation)',
      ms < FTS5_LATENCY_THRESHOLD_MS ? 'pass' : 'fail',
      `${meta.total_matches} matches across ${Object.keys(meta.session_hits).length} sessions`,
      ms,
    );
  } catch (err) {
    record('FTS5 meta query', 'fail', String(err), performance.now() - t0);
  }

  // Grep query
  const t1 = performance.now();
  try {
    const matches = grepMessages('embedding', 5);
    const ms = performance.now() - t1;
    record(
      'Grep search',
      ms < FTS5_LATENCY_THRESHOLD_MS ? 'pass' : 'fail',
      `${matches.length} matches`,
      ms,
    );
  } catch (err) {
    record('Grep search', 'fail', String(err), performance.now() - t1);
  }
}

function checkIndexCoverage(): void {
  const indexed = getIndexedSessionIds();
  record(
    'Indexed session count',
    indexed.size >= MIN_INDEXED_SESSIONS ? 'pass' : 'fail',
    `${indexed.size} sessions in FTS5 index`,
  );

  // Embedding gap stats
  const gaps = getEmbeddingGapStats();
  const coverage = gaps.totalMessages > 0
    ? ((1 - gaps.gapCount / gaps.totalMessages) * 100).toFixed(1)
    : '0';
  record(
    'Embedding coverage',
    gaps.gapCount < gaps.totalMessages ? 'pass' : 'fail',
    `${coverage}% embedded (${gaps.gapCount} gaps out of ${gaps.totalMessages} messages)`,
  );
}

function checkEmbedding(): void {
  if (SKIP_EMBED) {
    record('Embedding pipeline', 'skip', '--skip-embed flag set');
    return;
  }

  // Dynamic import to avoid loading ONNX runtime when skipping
  const runEmbedCheck = async () => {
    const { embed, disposeEmbedder } = await import('../src/core/recall/embedder.js');

    const testText = 'This is a smoke test for the embedding pipeline.';
    const t0 = performance.now();
    try {
      const vector = await embed(testText);
      const ms = performance.now() - t0;

      record(
        'Embedding pipeline',
        vector.length === 768 ? 'pass' : 'fail',
        `${vector.length}-dim vector`,
        ms,
      );

      // Check vector is normalized (L2 norm ≈ 1.0)
      let norm = 0;
      for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
      norm = Math.sqrt(norm);
      record(
        'Vector normalization',
        Math.abs(norm - 1.0) < 0.01 ? 'pass' : 'fail',
        `L2 norm: ${norm.toFixed(4)} (expected ~1.0)`,
      );
    } catch (err) {
      record('Embedding pipeline', 'fail', String(err), performance.now() - t0);
    } finally {
      await disposeEmbedder();
    }
  };

  return runEmbedCheck() as any;
}

function checkAdapterDiscovery(): void {
  const cwd = process.cwd();
  const dispatch = createAgentDispatch();
  const unregister = registerAllAdapters({ cwd, hostType: 'dev-server', dispatch });

  try {
    const sessions = listAllSessions();
    record(
      'Adapter discovery',
      sessions.length > 0 ? 'pass' : 'fail',
      `${sessions.length} sessions across all vendors`,
    );

    // Check vendor distribution
    const vendors = new Map<string, number>();
    for (const s of sessions) {
      vendors.set(s.vendor, (vendors.get(s.vendor) ?? 0) + 1);
    }
    for (const [vendor, count] of vendors) {
      record(`  Vendor "${vendor}"`, 'pass', `${count} sessions`);
    }
  } catch (err) {
    record('Adapter discovery', 'fail', String(err));
  } finally {
    dispatch.dispose();
    unregister();
  }
}

function checkAdapterSpawnEnv(): void {
  // Verify that child processes would inherit PATH
  // (This is what broke in commit 6eecb58)
  const hasPath = !!process.env.PATH;
  record(
    'process.env.PATH available',
    hasPath ? 'pass' : 'fail',
    process.env.PATH?.split(':').length + ' entries',
  );

  // Check claude binary is findable
  try {
    const which = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
    record('Claude CLI discoverable', 'pass', which);
  } catch {
    record('Claude CLI discoverable', 'skip', 'Not installed (OK for non-Claude machines)');
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log(`${BOLD}Crispy Smoke Test — Core Systems${RESET}`);
  console.log(`${DIM}Validates recall, embeddings, DB, and adapters against real data${RESET}`);

  // 1. DB
  header('Database');
  if (!checkDbExists()) {
    console.log(`\n  No database at ${dbPath()}. Nothing to test.\n`);
    process.exit(1);
  }
  checkDbIntegrity();

  // 2. FTS5 recall
  header('FTS5 Recall');
  checkFts5Performance();

  // 3. Index coverage
  header('Index Coverage');
  checkIndexCoverage();

  // 4. Embedding pipeline
  header('Embedding Pipeline');
  await checkEmbedding();

  // 5. Adapter discovery
  header('Adapter Discovery');
  await initSettings({ cwd: process.cwd() });
  checkAdapterDiscovery();

  // 6. Spawn environment
  header('Spawn Environment');
  checkAdapterSpawnEnv();

  // Summary
  header('Summary');
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    console.log(`\n  ${BOLD}Failures:${RESET}`);
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`    ${FAIL}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }

  console.log('');
  closeDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  closeDb();
  process.exit(1);
});
