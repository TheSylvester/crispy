/**
 * Tracker Notifications — Fire-and-forget notifications for project tracking events
 *
 * Follows the log.ts subscriber pattern but without ring buffer.
 * Subscribers receive notifications as they arrive; no snapshot on subscribe.
 *
 * @module rosie/tracker/tracker-notifications
 */

// ============================================================================
// Types
// ============================================================================

export interface TrackerNotification {
  id: number;
  ts: number;
  kind: 'project_created' | 'project_matched' | 'stage_change' | 'trivial';
  projectTitle?: string;
  icon?: string;
  oldStage?: string;
  newStage?: string;
  status?: string;
}

export type TrackerNotifyEvent =
  | { type: 'tracker_notification'; notification: TrackerNotification };

export interface TrackerNotifySubscriber {
  readonly id: string;
  send(event: TrackerNotifyEvent): void;
}

/** Sentinel sessionId used to route tracker notifications on the shared event channel. */
export const TRACKER_NOTIFY_CHANNEL_ID = '__tracker_notify__';

// ============================================================================
// Module State
// ============================================================================

let nextId = 1;
const subscribers = new Map<string, TrackerNotifySubscriber>();

// ============================================================================
// Public API
// ============================================================================

/** Push a tracker notification to all subscribers. */
export function pushTrackerNotification(
  notification: Omit<TrackerNotification, 'id' | 'ts'>,
): void {
  const full: TrackerNotification = {
    id: nextId++,
    ts: Date.now(),
    ...notification,
  };

  for (const sub of subscribers.values()) {
    sub.send({ type: 'tracker_notification', notification: full });
  }
}

/** Subscribe to tracker notifications. */
export function subscribeTrackerNotify(sub: TrackerNotifySubscriber): void {
  subscribers.set(sub.id, sub);
}

/** Unsubscribe from tracker notifications. */
export function unsubscribeTrackerNotify(subOrId: TrackerNotifySubscriber | string): void {
  const id = typeof subOrId === 'string' ? subOrId : subOrId.id;
  subscribers.delete(id);
}
