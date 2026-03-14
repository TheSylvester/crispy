/**
 * useProjectActivity — Fetches activity history for a project
 *
 * @module hooks/useProjectActivity
 */

import { useState, useEffect, useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import type { WireProjectActivity } from '../transport.js';

export function useProjectActivity(
  projectId: string | null,
  opts?: { kind?: string },
): {
  entries: WireProjectActivity[];
  loading: boolean;
  refresh: () => void;
} {
  const transport = useTransport();
  const [entries, setEntries] = useState<WireProjectActivity[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(() => {
    if (!projectId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    transport.getProjectActivity(projectId, opts)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [transport, projectId, opts?.kind]);

  useEffect(() => { fetch(); }, [fetch]);

  return { entries, loading, refresh: fetch };
}
