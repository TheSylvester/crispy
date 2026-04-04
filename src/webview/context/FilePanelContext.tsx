/**
 * File Panel Context — active file view state and callbacks
 *
 * Owns the transient (session-scoped) state for the file viewer panel: which
 * file is currently open, plus callbacks to open files and insert text into
 * chat. Separate from PreferencesContext because preferences are persistent
 * user settings; the active file view is ephemeral.
 *
 * @module FilePanelContext
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTransport } from './TransportContext.js';
import { useTabSession } from './TabSessionContext.js';
import { useActiveTabPanelBridge } from './TabPanelContext.js';
import { inferLanguage } from '../renderers/tools/shared/tool-utils.js';

// ============================================================================
// Types
// ============================================================================

export interface ActiveFileView {
  path: string;           // absolute path
  relativePath: string;   // relative to cwd (for display)
  content: string;
  language: string;       // inferred from extension
  size: number;
  line?: number;          // 1-based line to highlight (Phase 2 will scroll to it)
}

interface FilePanelContextValue {
  activeFileView: ActiveFileView | null;
  /** Whether the file viewer panel is open */
  fileViewerOpen: boolean;
  /** Open a file in the file viewer panel (relative path, prepends cwd) */
  openFile: (relativePath: string, line?: number) => Promise<void>;
  /** Open a file by absolute path in the file viewer panel */
  openFileAbsolute: (absolutePath: string, line?: number) => Promise<void>;
  /** Insert text into the chat input at cursor position */
  insertIntoChat: (text: string) => void;
  /** Register a callback to handle insertIntoChat. Called by TranscriptViewer. */
  registerInsertHandler: (handler: (text: string) => void) => void;
  /** Close the file viewer panel and clear active file */
  closeFile: () => void;
  /** The resolved cwd (absolute path), or null if no project selected */
  cwd: string | null;
  /** Loading state for file reads */
  loading: boolean;
  /** Error message from last failed read */
  error: string | null;
}

const FilePanelContext = createContext<FilePanelContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface FilePanelProviderProps {
  children: ReactNode;
}

export function FilePanelProvider({ children }: FilePanelProviderProps): React.JSX.Element {
  const transport = useTransport();
  const bridge = useActiveTabPanelBridge();
  const [fileViewerOpen, setFileViewerOpenRaw] = useState(false);
  const { effectiveCwd } = useTabSession();
  const fullPath = effectiveCwd.fullPath;

  // Wrap setFileViewerOpen to also push to the bridge
  const setFileViewerOpen = useCallback((open: boolean) => {
    setFileViewerOpenRaw(open);
    bridge?.publishFileViewerOpen(open);
  }, [bridge]);
  const [activeFileView, setActiveFileView] = useState<ActiveFileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref-based insert handler — registered by TranscriptViewer, called by context menu commands.
  // Avoids prop-drilling through the component tree.
  const insertHandlerRef = useRef<((text: string) => void) | null>(null);

  const registerInsertHandler = useCallback((handler: (text: string) => void) => {
    insertHandlerRef.current = handler;
  }, []);

  const openFile = useCallback(async (relativePath: string, line?: number) => {
    if (!fullPath) return;

    const absolutePath = `${fullPath}/${relativePath}`;
    setLoading(true);
    setError(null);

    try {
      const { content, size } = await transport.readFile(absolutePath);
      setActiveFileView({
        path: absolutePath,
        relativePath,
        content,
        language: inferLanguage(relativePath),
        size,
        line,
      });
      // Open file viewer panel
      setFileViewerOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Still open panel to show the error
      setFileViewerOpen(true);
    } finally {
      setLoading(false);
    }
  }, [fullPath, transport]);

  const openFileAbsolute = useCallback(async (absolutePath: string, line?: number) => {
    // Derive relativePath by stripping cwd prefix
    let relativePath: string;
    if (fullPath && absolutePath.startsWith(fullPath + '/')) {
      relativePath = absolutePath.slice(fullPath.length + 1);
    } else {
      // Outside cwd or no cwd — use filename
      relativePath = absolutePath.split('/').pop() ?? absolutePath;
    }

    setLoading(true);
    setError(null);

    try {
      const { content, size } = await transport.readFile(absolutePath);
      setActiveFileView({
        path: absolutePath,
        relativePath,
        content,
        language: inferLanguage(relativePath),
        size,
        line,
      });
      setFileViewerOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setFileViewerOpen(true);
    } finally {
      setLoading(false);
    }
  }, [fullPath, transport]);

  const closeFile = useCallback(() => {
    setFileViewerOpen(false);
    setActiveFileView(null);
    setError(null);
  }, [setFileViewerOpen]);

  // Register closeFile with bridge so TitleBar can close the file viewer
  useEffect(() => {
    bridge?.registerFileViewerCloser(closeFile);
  }, [bridge, closeFile]);

  const insertIntoChat = useCallback((text: string) => {
    insertHandlerRef.current?.(text);
  }, []);

  const value: FilePanelContextValue = useMemo(() => ({
    activeFileView,
    fileViewerOpen,
    openFile,
    openFileAbsolute,
    insertIntoChat,
    registerInsertHandler,
    closeFile,
    cwd: fullPath,
    loading,
    error,
  }), [activeFileView, fileViewerOpen, openFile, openFileAbsolute, insertIntoChat, registerInsertHandler, closeFile, fullPath, loading, error]);

  return (
    <FilePanelContext.Provider value={value}>
      {children}
    </FilePanelContext.Provider>
  );
}

/**
 * Access file panel state and callbacks.
 * Must be used within FilePanelProvider.
 */
export function useFilePanel(): FilePanelContextValue {
  const ctx = useContext(FilePanelContext);
  if (!ctx) throw new Error('useFilePanel must be used within FilePanelProvider');
  return ctx;
}
