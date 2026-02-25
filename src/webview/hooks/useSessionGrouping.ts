/**
 * useSessionGrouping — time-based session grouping hook
 *
 * Takes a flat array of WireSessionInfo and returns groups ordered by
 * time proximity (Today, Yesterday, Past Week, Past Month, Older).
 * Empty groups are omitted. Sessions within each group are sorted by
 * modifiedAt descending.
 *
 * Does NOT handle filtering, render caps, or search — those are upstream
 * concerns in the SessionSelector component.
 *
 * @module useSessionGrouping
 */

import { useMemo } from 'react';
import type { WireSessionInfo } from '../transport.js';

// ============================================================================
// Types
// ============================================================================

export type TimeGroup = 'today' | 'yesterday' | 'past_week' | 'past_month' | 'older';

export const GROUP_ORDER: TimeGroup[] = [
  'today', 'yesterday', 'past_week', 'past_month', 'older',
];

export const GROUP_LABELS: Record<TimeGroup, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  past_week: 'Past Week',
  past_month: 'Past Month',
  older: 'Older',
};

export interface SessionGroup {
  key: TimeGroup;
  label: string;
  sessions: WireSessionInfo[];
}

export interface GroupedSessions {
  groups: SessionGroup[];
  totalCount: number;
}

// ============================================================================
// Grouping Logic
// ============================================================================

/**
 * Classify an ISO date string into one of five time groups.
 *
 * - "today" and "yesterday" use calendar-day boundaries (midnight-based).
 * - "past_week" and "past_month" use rolling durations from now.
 * - A session modified at exactly midnight today is "today".
 */
export function getTimeGroup(isoDate: string): TimeGroup {
  const mtime = new Date(isoDate).getTime();
  const now = new Date();

  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  if (mtime >= todayMidnight.getTime()) return 'today';

  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
  if (mtime >= yesterdayMidnight.getTime()) return 'yesterday';

  const diff = now.getTime() - mtime;
  if (diff < 7 * 86_400_000) return 'past_week';
  if (diff < 30 * 86_400_000) return 'past_month';
  return 'older';
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Group sessions by time proximity.
 *
 * Returns non-empty groups in GROUP_ORDER, with sessions within each group
 * sorted by modifiedAt descending (most recent first).
 */
export function useSessionGrouping(sessions: WireSessionInfo[]): GroupedSessions {
  return useMemo(() => {
    const buckets = new Map<TimeGroup, WireSessionInfo[]>();

    for (const session of sessions) {
      const group = getTimeGroup(session.modifiedAt);
      const bucket = buckets.get(group) ?? [];
      bucket.push(session);
      buckets.set(group, bucket);
    }

    // Sort within each bucket by modifiedAt descending
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) =>
        new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
      );
    }

    // Build output in GROUP_ORDER, skipping empty groups
    const groups = GROUP_ORDER
      .filter(key => buckets.has(key))
      .map(key => ({
        key,
        label: GROUP_LABELS[key],
        sessions: buckets.get(key)!,
      }));

    return {
      groups,
      totalCount: sessions.length,
    };
  }, [sessions]);
}
