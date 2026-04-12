/**
 * File Index Context — provides the git file match index to the component tree
 *
 * Fetches the git file list via transport on CWD change, builds an in-memory
 * match index, and exposes it to consumers. Keeps the index fresh by
 * re-fetching on agent idle transitions (debounced). Returns null gracefully
 * if no CWD or fetch fails.
 *
 * @module FileIndexContext
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTransport } from './TransportContext.js';
import { useTabSession } from './TabSessionContext.js';
import { buildMatchIndex, type FileIndex } from '../utils/file-index.js';

const FileIndexContext = createContext<FileIndex | null>(null);

/** Tools that create or modify files on disk. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Raw git file list — used by the file tree panel (not the match index). */
const GitFilesContext = createContext<string[] | null>(null);

const RefreshGitFilesContext = createContext<(() => void) | null>(null);

export function FileIndexProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const transport = useTransport();
  const { effectiveSessionId: selectedSessionId, effectiveCwd } = useTabSession();
  const fullPath = effectiveCwd.fullPath;
  const [gitFiles, setGitFiles] = useState<string[] | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const refresh = useCallback(() => setRefreshCounter(c => c + 1), []);

  // Re-fetch file index on idle transitions and after file-writing tool calls.
  // The idle refresh catches end-of-turn changes. The tool_use refresh catches
  // files created mid-turn so linkify resolves them before the turn ends.
  useEffect(() => {
    if (!selectedSessionId || !fullPath) return;

    const off = transport.onEvent((sid, event) => {
      if (sid !== selectedSessionId) return;

      if (
        event.type === 'event' &&
        event.event.type === 'status' &&
        event.event.status === 'idle'
      ) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(refresh, 300);
      }

      // Refresh after file-writing tools so newly created files are linkifiable
      if (event.type === 'entry' && event.entry.message) {
        const content = event.entry.message.content;
        if (Array.isArray(content)) {
          const hasFileWrite = content.some(
            (b) => b.type === 'tool_use' && FILE_WRITE_TOOLS.has(b.name),
          );
          if (hasFileWrite) {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(refresh, 500);
          }
        }
      }
    });

    return () => {
      off();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [selectedSessionId, fullPath, transport, refresh]);

  const index = useMemo(() => {
    if (!gitFiles || !fullPath) return null;
    return buildMatchIndex(gitFiles, fullPath);
  }, [gitFiles, fullPath]);

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
