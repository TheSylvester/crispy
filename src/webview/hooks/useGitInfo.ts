/**
 * useGitInfo — polls git branch name + dirty status for the current CWD
 *
 * Calls `transport.getGitBranchInfo(fullPath)` on mount and every 10 seconds.
 * Returns `null` when CWD is unknown or not a git repo.
 *
 * @module useGitInfo
 */

import { useEffect, useRef, useState } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { useCwd } from './useSessionCwd.js';

export interface GitInfo {
  branch: string;
  dirty: boolean;
}

const POLL_INTERVAL = 30_000;

export function useGitInfo(): GitInfo | null {
  const transport = useTransport();
  const { fullPath } = useCwd();
  const [info, setInfo] = useState<GitInfo | null>(null);
  const fullPathRef = useRef(fullPath);
  fullPathRef.current = fullPath;

  useEffect(() => {
    if (!fullPath) {
      setInfo(null);
      return;
    }

    let cancelled = false;

    const fetch = () => {
      transport.getGitBranchInfo(fullPath).then(
        (result) => { if (!cancelled) setInfo(result); },
        () => { if (!cancelled) setInfo(null); },
      );
    };

    fetch();
    const id = setInterval(fetch, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [fullPath, transport]);

  return info;
}
