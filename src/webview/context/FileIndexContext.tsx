/**
 * File Index Context — provides the git file match index to the component tree
 *
 * Fetches the git file list via transport on CWD change, builds an in-memory
 * match index, and exposes it to consumers. Returns null gracefully if no CWD
 * or fetch fails.
 *
 * @module FileIndexContext
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTransport } from './TransportContext.js';
import { useCwd } from '../hooks/useSessionCwd.js';
import { buildMatchIndex, type FileIndex } from '../utils/file-index.js';

const FileIndexContext = createContext<FileIndex | null>(null);

/** Raw git file list — used by the file tree panel (not the match index). */
const GitFilesContext = createContext<string[] | null>(null);

const RefreshGitFilesContext = createContext<(() => void) | null>(null);

export function FileIndexProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const transport = useTransport();
  const { fullPath } = useCwd();
  const [gitFiles, setGitFiles] = useState<string[] | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

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
  }, [transport, fullPath, refreshCounter]);

  const index = useMemo(() => {
    if (!gitFiles || !fullPath) return null;
    return buildMatchIndex(gitFiles, fullPath);
  }, [gitFiles, fullPath]);

  const refresh = useCallback(() => setRefreshCounter(c => c + 1), []);

  return (
    <RefreshGitFilesContext.Provider value={refresh}>
      <GitFilesContext.Provider value={gitFiles}>
        <FileIndexContext.Provider value={index}>
          {children}
        </FileIndexContext.Provider>
      </GitFilesContext.Provider>
    </RefreshGitFilesContext.Provider>
  );
}

/**
 * Access the file index. Returns null if no CWD, fetch pending, or fetch failed.
 */
export function useFileIndex(): FileIndex | null {
  return useContext(FileIndexContext);
}

/**
 * Access the raw git file list. Returns null if no CWD, fetch pending, or fetch failed.
 * Used by the file tree panel to build the directory tree.
 */
export function useGitFiles(): string[] | null {
  return useContext(GitFilesContext);
}

/**
 * Get a callback to refresh the git file list.
 */
export function useRefreshGitFiles(): () => void {
  const refresh = useContext(RefreshGitFilesContext);
  if (!refresh) throw new Error('useRefreshGitFiles must be used within FileIndexProvider');
  return refresh;
}
