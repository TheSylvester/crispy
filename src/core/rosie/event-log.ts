/**
 * Persistent Event Log — structured diagnostic events to SQLite
 *
 * Best-effort write; failures log to stderr, never throw.
 * Not re-exported from rosie/index.ts (no import cycle risk).
 *
 * @module rosie/event-log
 */

import { getDb } from '../crispy-db.js';
import { dbPath as crispyDbPath } from '../activity-index.js';

export interface EventLogEntry {
  source: string;
  level?: 'info' | 'warn' | 'error';
  summary: string;
  data?: unknown;
}

const INSERT_SQL = `INSERT INTO event_log (ts, source, level, summary, data) VALUES (?, ?, ?, ?, ?)`;

export function pushEventLog(entry: EventLogEntry, dbPathOverride?: string): void {
  try {
    const db = getDb(dbPathOverride ?? crispyDbPath());
    db.run(INSERT_SQL, [
      Date.now(),
      entry.source,
      entry.level ?? 'info',
      entry.summary,
      entry.data !== undefined ? JSON.stringify(entry.data) : null,
    ]);
  } catch (err) {
    console.error('[event-log] DB write failed:', err instanceof Error ? err.message : String(err));
  }
}
