/**
 * useTrackerNotifications — Subscribe to tracker notification events
 *
 * Wires transport-pushed tracker notifications into the shared
 * `ToastChannel` queue. Auto-dismiss timer, click-dismiss, and queue
 * fan-out are owned by `toast-channel.ts` so behavior can't drift from
 * ErrorToast's lifecycle.
 *
 * @module hooks/useTrackerNotifications
 */

import { useEffect, useRef } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { TRACKER_NOTIFY_CHANNEL_ID } from '../../core/rosie/tracker/tracker-notifications.js';
import type { TrackerNotification, TrackerNotifyEvent } from '../../core/rosie/tracker/tracker-notifications.js';
import {
  createToastChannel,
  useToastChannel,
  type ToastChannel,
} from '../components/notifications/toast-channel.js';

export function useTrackerNotifications(): {
  notifications: readonly TrackerNotification[];
  dismiss: (id: number) => void;
} {
  const transport = useTransport();
  // One channel per hook instance: tracker subscriptions are tied to the
  // mounting component, so its queue should die with it.
  const channelRef = useRef<ToastChannel<TrackerNotification> | null>(null);
  if (!channelRef.current) {
    channelRef.current = createToastChannel<TrackerNotification>();
  }

  useEffect(() => {
    let unmounted = false;

    transport.subscribeTrackerNotify().catch(() => {});

    const off = transport.onEvent((sessionId, event) => {
      if (unmounted || sessionId !== TRACKER_NOTIFY_CHANNEL_ID) return;
      const trackerEvent = event as TrackerNotifyEvent;
      if (trackerEvent.type === 'tracker_notification') {
        channelRef.current!.push(trackerEvent.notification);
      }
    });

    return () => {
      unmounted = true;
      off();
      transport.unsubscribeTrackerNotify().catch(() => {});
    };
  }, [transport]);

  const { items, dismiss } = useToastChannel(channelRef.current);
  return { notifications: items, dismiss };
}
