/**
 * File Index Context — provides the git file match index to the component tree
 *
 * Fetches the git file list via transport on CWD change, builds an in-memory
 * match index, and exposes it to consumers. Returns null gracefully if no CWD
 * or fetch fails.
 *
 * @module FileIndexContext
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useTransport } from './TransportContext.js';
import { useCwd } from '../hooks/useSessionCwd.js';
import { buildMatchIndex, type FileIndex } from '../utils/file-index.js';

const FileIndexContext = createContext<FileIndex | null>(null);

export function FileIndexProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const transport = useTransport();
  const { fullPath } = useCwd();
  const [gitFiles, setGitFiles] = useState<string[] | null>(null);

  useEffect(() => {
    if (!fullPath) {
      setGitFiles(null);
      return;
    }

    let cancelled = false;

    transport.getGitFiles(fullPath).then(
      (files) => {
        if (!cancelled) setGitFiles(files);
      },
      (err) => {
        if (!cancelled) {
          console.warn('[crispy] Failed to fetch git files:', err);
          setGitFiles(null);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [transport, fullPath]);

  const index = useMemo(() => {
    if (!gitFiles || !fullPath) return null;
    return buildMatchIndex(gitFiles, fullPath);
  }, [gitFiles, fullPath]);

  return (
    <FileIndexContext.Provider value={index}>
      {children}
    </FileIndexContext.Provider>
  );
}

/**
 * Access the file index. Returns null if no CWD, fetch pending, or fetch failed.
 */
export function useFileIndex(): FileIndex | null {
  return useContext(FileIndexContext);
}
