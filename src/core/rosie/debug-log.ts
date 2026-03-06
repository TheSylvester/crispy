/**
 * Rosie Debug Log — Structured log stream for observability
 *
 * Ring-buffered log entries from core modules (summarize results, debug info,
 * warnings). Subscribers receive a snapshot on subscribe, then incremental
 * entries as they arrive.
 *
 * Subscriber shape mirrors SessionListSubscriber: { id, send(event) }.
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
  level: 'info' | 'warn' | 'error';
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
  const full: RosieLogEntry = {
    id: nextId++,
    ts: Date.now(),
    ...entry,
  };
  buffer.push(full);
  if (buffer.length > BUFFER_CAP) {
    buffer.splice(0, buffer.length - BUFFER_CAP);
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
