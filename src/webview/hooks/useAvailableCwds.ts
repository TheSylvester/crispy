/**
 * useAvailableCwds — unique project CWDs derived from loaded sessions
 *
 * Deduplicates on projectSlug (canonical key — avoids lossy slug↔path round-trips).
 * Sorted by most recently used: latest modifiedAt among sessions sharing that slug.
 *
 * @module useAvailableCwds
 */

import { useMemo } from 'react';
import { useSession } from '../context/SessionContext.js';
import { slugToPath, formatCwd } from './useSessionCwd.js';

/** Full CWD info with non-null fields (all entries have a known slug) */
export interface AvailableCwd {
  slug: string;
  fullPath: string;
  display: string;
}

export function useAvailableCwds(): AvailableCwd[] {
  const { sessions } = useSession();

  return useMemo(() => {
    // Group sessions by projectSlug, tracking the latest modifiedAt per slug
    const slugMap = new Map<string, number>(); // slug → latest modifiedAt timestamp

    for (const session of sessions) {
      if (!session.projectSlug) continue;
      const slug = session.projectSlug;
      const ts = new Date(session.modifiedAt).getTime();
      const existing = slugMap.get(slug);
      if (existing === undefined || ts > existing) {
        slugMap.set(slug, ts);
      }
    }

    // Convert to AvailableCwd[] and sort by most recently used (descending)
    const cwds: (AvailableCwd & { ts: number })[] = [];
    for (const [slug, ts] of slugMap) {
      const fullPath = slugToPath(slug);
      cwds.push({ slug, fullPath, display: formatCwd(fullPath), ts });
    }

    cwds.sort((a, b) => b.ts - a.ts);

    // Strip the internal sort key
    return cwds.map(({ slug, fullPath, display }) => ({ slug, fullPath, display }));
  }, [sessions]);
}
