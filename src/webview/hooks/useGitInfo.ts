/**
 * useGitInfo — polls git branch name + dirty status for a CWD
 *
 * Calls `transport.getGitBranchInfo(cwd)` on mount and every 30 seconds.
 * When `cwd` is omitted, defaults to the active session's CWD.
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

export function useGitInfo(cwd?: string): GitInfo | null {
  const transport = useTransport();
  const activeCwd = useCwd().fullPath;
  const fullPath = cwd ?? activeCwd;
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
