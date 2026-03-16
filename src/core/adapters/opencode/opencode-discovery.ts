/**
 * opencode-discovery.ts
 *
 * VendorDiscovery implementation for OpenCode using SQLite DB via `sqlite3` CLI.
 *
 * Responsibilities:
 * - Session listing from OpenCode's SQLite DB
 * - Session history loading (messages + parts → entry adapter)
 * - Subagent entry reading for child sessions
 *
 * Does NOT:
 * - Manage live sessions (that's the adapter's job)
 * - Write to the DB (read-only)
 *
 * Uses `sqlite3 -json` CLI instead of node-sqlite3-wasm because OpenCode's
 * DB uses WAL mode, which the WASM SQLite can't read (no mmap/shared memory).
 * Discovery is read-only, load-time only — not hot path.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { VendorDiscovery, SessionInfo, SubagentEntriesResult } from '../../agent-adapter.js';
import type { TranscriptEntry } from '../../transcript.js';
import type { Part } from '@opencode-ai/sdk/client';
import { adaptOpenCodePart } from './opencode-entry-adapter.js';
import { log } from '../../log.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// DB Path Resolution
// ============================================================================

/** Resolve the OpenCode SQLite DB path. */
function getDbPath(): string {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdgData, 'opencode', 'opencode.db');
}

// ============================================================================
// SQLite CLI Helper
// ============================================================================

/**
 * Execute a SQL query via `sqlite3 -json` and parse the result.
 *
 * @returns Parsed JSON array, or empty array on failure.
 */
async function queryDb<T>(dbPath: string, sql: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') return [];

    return JSON.parse(trimmed) as T[];
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      log({ level: 'error', source: 'opencode-discovery', summary: 'sqlite3 CLI not found — install sqlite3 to list OpenCode sessions' });
      return [];
    }
    throw err;
  }
}

// ============================================================================
// Row Types
// ============================================================================

interface SessionRow {
  id: string;
  project_id: string;
  directory: string;
  title: string;
  slug?: string;
  parent_id: string | null;
  summary_additions?: number;
  summary_deletions?: number;
  summary_files?: number;
  time_created: string;
  time_updated: string;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  data: string; // JSON
}

// ============================================================================
// OpenCodeDiscovery
// ============================================================================

class OpenCodeDiscovery implements VendorDiscovery {
  readonly vendor = 'opencode' as const;

  private sessionCache: SessionInfo[] = [];
  private cacheTimestamp = 0;
  private readonly cacheTtlMs = 30_000;
  private refreshing = false;
  private refreshPromise: Promise<void> | null = null;

  findSession(sessionId: string): SessionInfo | undefined {
    this.maybeRefresh();
    return this.sessionCache.find((s) => s.sessionId === sessionId);
  }

  listSessions(): SessionInfo[] {
    this.maybeRefresh();
    return this.sessionCache;
  }

  async loadHistory(sessionId: string): Promise<TranscriptEntry[]> {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return [];

    // Single JOIN query — avoids N+1 per-message part queries
    const rows = await queryDb<PartRow>(
      dbPath,
      `SELECT p.id, p.message_id, p.session_id, p.data
       FROM part p
       INNER JOIN message m ON p.message_id = m.id
       WHERE m.session_id = '${escapeSql(sessionId)}'
       ORDER BY m.time_created ASC, p.id ASC`,
    );

    const entries: TranscriptEntry[] = [];

    for (const partRow of rows) {
      try {
        const partData = JSON.parse(partRow.data) as Partial<Part>;
        const part = {
          ...partData,
          id: partRow.id,
          sessionID: partRow.session_id,
          messageID: partRow.message_id,
        } as Part;

        const adapted = adaptOpenCodePart(part, sessionId);
        entries.push(...adapted);
      } catch (err) {
        log({ level: 'warn', source: 'opencode-discovery', summary: `Failed to parse part: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
      }
    }

    return entries;
  }

  readSubagentEntries(
    _sessionId: string,
    agentId: string,
    parentToolUseId: string,
    cursor: string,
  ): SubagentEntriesResult {
    // agentId is the child session ID
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) {
      return { entries: [], cursor: '', done: true };
    }

    // Synchronous version — discovery is not hot path
    // Use execFileSync for simplicity since readSubagentEntries is sync
    try {
      const offset = cursor ? parseInt(cursor, 10) : 0;

      const partsJson = execFileSync('sqlite3', [
        '-json', dbPath,
        `SELECT p.id, p.message_id, p.session_id, p.data FROM part p INNER JOIN message m ON p.message_id = m.id WHERE m.session_id = '${escapeSql(agentId)}' ORDER BY m.time_created ASC, p.id ASC LIMIT 100 OFFSET ${offset}`,
      ], { encoding: 'utf-8', timeout: 10_000 }).trim();

      if (!partsJson || partsJson === '[]') {
        return { entries: [], cursor: String(offset), done: true };
      }

      const rows = JSON.parse(partsJson) as PartRow[];
      const entries: TranscriptEntry[] = [];

      for (const row of rows) {
        try {
          const partData = JSON.parse(row.data) as Partial<Part>;
          const part = {
            ...partData,
            id: row.id,
            sessionID: row.session_id,
            messageID: row.message_id,
          } as Part;

          const adapted = adaptOpenCodePart(part, agentId);
          for (const entry of adapted) {
            entry.parentToolUseID = parentToolUseId;
            entries.push(entry);
          }
        } catch {
          // Skip malformed parts
        }
      }

      const newOffset = offset + rows.length;
      return {
        entries,
        cursor: String(newOffset),
        done: rows.length < 100,
      };
    } catch (err) {
      log({ level: 'error', source: 'opencode-discovery', summary: `readSubagentEntries failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
      return { entries: [], cursor: '', done: true };
    }
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private maybeRefresh(): void {
    const stale = Date.now() - this.cacheTimestamp > this.cacheTtlMs;
    if ((stale || this.sessionCache.length === 0) && !this.refreshing) {
      this.refresh().catch((err) => {
        log({ level: 'error', source: 'opencode-discovery', summary: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
      });
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing && this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshing = false;
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<void> {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) {
      this.sessionCache = [];
      this.cacheTimestamp = Date.now();
      return;
    }

    // Try with summary column first; fall back without it for older OpenCode
    // schemas that lack the column (the summary stats are cosmetic only).
    let rows: SessionRow[];
    try {
      rows = await queryDb<SessionRow>(
        dbPath,
        `SELECT id, project_id, directory, title, parent_id,
                COALESCE(json_extract(summary, '$.additions'), 0) as summary_additions,
                COALESCE(json_extract(summary, '$.deletions'), 0) as summary_deletions,
                COALESCE(json_extract(summary, '$.files'), 0) as summary_files,
                time_created, time_updated
         FROM session ORDER BY time_updated DESC`,
      );
    } catch {
      try {
        rows = await queryDb<SessionRow>(
          dbPath,
          `SELECT id, project_id, directory, title, parent_id,
                  0 as summary_additions, 0 as summary_deletions, 0 as summary_files,
                  time_created, time_updated
           FROM session ORDER BY time_updated DESC`,
        );
      } catch (fallbackErr) {
        log({ level: 'error', source: 'opencode-discovery', summary: `Query failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`, data: { error: String(fallbackErr) } });
        return;
      }
    }

    this.sessionCache = rows.map((row) => this.rowToSessionInfo(row, dbPath));
    this.cacheTimestamp = Date.now();
  }

  private rowToSessionInfo(row: SessionRow, dbPath: string): SessionInfo {
    return {
      sessionId: row.id,
      path: dbPath,
      projectSlug: this.deriveProjectSlug(row.directory),
      projectPath: row.directory,
      modifiedAt: new Date(row.time_updated),
      size: (row.summary_additions ?? 0) + (row.summary_deletions ?? 0),
      label: row.title || undefined,
      vendor: 'opencode',
      isSidechain: row.parent_id !== null && row.parent_id !== undefined,
    };
  }

  private deriveProjectSlug(directory: string): string {
    return directory.replace(/[\\/]/g, '-');
  }
}

// ============================================================================
// SQL Helpers
// ============================================================================

/** Escape single quotes for SQL string literals. */
function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

// ============================================================================
// Singleton Export
// ============================================================================

export const opencodeDiscovery = new OpenCodeDiscovery();
