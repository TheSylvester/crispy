/**
 * useTrackerNotifications — Subscribe to tracker notification events
 *
 * Subscribes on mount, auto-dismisses notifications after 4 seconds.
 *
 * @module hooks/useTrackerNotifications
 */

import { useState, useEffect, useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { TRACKER_NOTIFY_CHANNEL_ID } from '../../core/rosie/tracker/tracker-notifications.js';
import type { TrackerNotification, TrackerNotifyEvent } from '../../core/rosie/tracker/tracker-notifications.js';

const AUTO_DISMISS_MS = 4000;

export function useTrackerNotifications(): {
  notifications: TrackerNotification[];
  dismiss: (id: number) => void;
} {
  const transport = useTransport();
  const [notifications, setNotifications] = useState<TrackerNotification[]>([]);

  const dismiss = useCallback((id: number) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  useEffect(() => {
    let unmounted = false;

    transport.subscribeTrackerNotify().catch(() => {});

    const off = transport.onEvent((sessionId, event) => {
      if (unmounted || sessionId !== TRACKER_NOTIFY_CHANNEL_ID) return;
      const trackerEvent = event as TrackerNotifyEvent;

      if (trackerEvent.type === 'tracker_notification') {
        const notification = trackerEvent.notification;
        setNotifications(prev => [...prev, notification]);

        // Auto-dismiss after timeout
        setTimeout(() => {
          if (!unmounted) {
            setNotifications(prev => prev.filter(n => n.id !== notification.id));
          }
        }, AUTO_DISMISS_MS);
      }
    });

    return () => {
      unmounted = true;
      off();
      transport.unsubscribeTrackerNotify().catch(() => {});
    };
  }, [transport]);

  return { notifications, dismiss };
}
