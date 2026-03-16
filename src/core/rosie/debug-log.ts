/**
 * Rosie Debug Log — Structured log stream for observability
 *
 * Ring-buffered log entries from core modules (summarize results, debug info,
 * warnings). Subscribers receive a snapshot on subscribe, then incremental
 * entries as they arrive.
 *
 * Subscriber shape mirrors SessionListSubscriber: { id, send(event) }.
 *
 * Log level threshold is controlled by the CRISPY_LOG_LEVEL env var (default: 'info').
 * Set CRISPY_LOG_LEVEL=debug to enable verbose instrumentation logs.
 *
 * @module rosie/debug-log
 */

// ============================================================================
// Types
// ============================================================================

export interface RosieLogEntry {
  id: number;
  ts: number;
  source: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  summary: string;
  data?: unknown;
}

export type RosieLogEvent =
  | { type: 'rosie_log_entry'; entry: RosieLogEntry }
  | { type: 'rosie_log_snapshot'; entries: RosieLogEntry[] };

export interface RosieLogSubscriber {
  readonly id: string;
  send(event: RosieLogEvent): void;
}

/** Sentinel sessionId used to route rosie log events on the shared event channel. */
export const ROSIE_LOG_CHANNEL_ID = '__rosie_log__';

// ============================================================================
// Log level threshold (env-var gating)
// ============================================================================

const LEVEL_ORDER: Record<RosieLogEntry['level'], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const _rawEnvLevel = process.env['CRISPY_LOG_LEVEL']?.toLowerCase();
const _thresholdLevel: RosieLogEntry['level'] =
  _rawEnvLevel === 'debug' || _rawEnvLevel === 'info' || _rawEnvLevel === 'warn' || _rawEnvLevel === 'error'
    ? _rawEnvLevel
    : 'info';
const _threshold = LEVEL_ORDER[_thresholdLevel];

// ============================================================================
// Persistence callback (late-binding to avoid circular imports)
// ============================================================================

/**
 * Optional callback that persists a log entry to durable storage (SQLite).
 * Registered by activity-index.ts at startup to break the circular dependency
 * (activity-index → rosie/index → debug-log).
 */
type PersistLogFn = (entry: RosieLogEntry) => void;
let _persistLog: PersistLogFn | null = null;

/** Register the persistence callback. Called once from activity-index.ts. */
export function registerLogPersister(fn: PersistLogFn): void {
  _persistLog = fn;
}

// ============================================================================
// Module State
// ============================================================================

const BUFFER_CAP = 200;
const buffer: RosieLogEntry[] = [];
let nextId = 1;
const subscribers = new Map<string, RosieLogSubscriber>();

// ============================================================================
// Public API
// ============================================================================

/** Append a log entry to the ring buffer and notify all subscribers. */
export function pushRosieLog(
  entry: Omit<RosieLogEntry, 'id' | 'ts'>,
): void {
  if (LEVEL_ORDER[entry.level] < _threshold) return;

  const full: RosieLogEntry = {
    id: nextId++,
    ts: Date.now(),
    ...entry,
  };
  buffer.push(full);
  if (buffer.length > BUFFER_CAP) {
    buffer.splice(0, buffer.length - BUFFER_CAP);
  }

  // Persist to SQLite for crash-survivable diagnostics
  if (_persistLog) {
    try {
      _persistLog(full);
    } catch {
      // Never let a DB error break the in-memory log path
    }
  }

  for (const sub of subscribers.values()) {
    sub.send({ type: 'rosie_log_entry', entry: full });
  }
}

/** Return current buffer contents (newest last). */
export function getRosieLogSnapshot(): RosieLogEntry[] {
  return [...buffer];
}

/** Subscribe to rosie log events. Sends snapshot immediately. Idempotent by ID. */
export function subscribeRosieLog(sub: RosieLogSubscriber): void {
  subscribers.set(sub.id, sub);
  sub.send({ type: 'rosie_log_snapshot', entries: getRosieLogSnapshot() });
}

/** Unsubscribe from rosie log events. */
export function unsubscribeRosieLog(subOrId: RosieLogSubscriber | string): void {
  const id = typeof subOrId === 'string' ? subOrId : subOrId.id;
  subscribers.delete(id);
}
