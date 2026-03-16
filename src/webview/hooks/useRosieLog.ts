/**
 * useRosieLog — Subscribe to the Rosie debug log stream
 *
 * Subscribes on mount, listens for rosie_log_snapshot and rosie_log_entry
 * events, unsubscribes on unmount. Returns entries newest-first.
 *
 * @module hooks/useRosieLog
 */

import { useState, useEffect } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { LOG_CHANNEL_ID } from '../../core/log.js';
import type { LogEntry, LogEvent } from '../../core/log.js';

const BUFFER_CAP = 200;

export function useRosieLog(): LogEntry[] {
  const transport = useTransport();
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    let unmounted = false;

    transport.subscribeLog().catch(() => {});

    const off = transport.onEvent((sessionId, event) => {
      if (unmounted || sessionId !== LOG_CHANNEL_ID) return;
      const rosieEvent = event as LogEvent;

      if (rosieEvent.type === 'rosie_log_snapshot') {
        setEntries([...rosieEvent.entries].reverse());
      } else if (rosieEvent.type === 'rosie_log_entry') {
        setEntries((prev) => {
          const next = [rosieEvent.entry, ...prev];
          return next.length > BUFFER_CAP ? next.slice(0, BUFFER_CAP) : next;
        });
      }
    });

    return () => {
      unmounted = true;
      off();
      transport.unsubscribeLog().catch(() => {});
    };
  }, [transport]);

  return entries;
}
