/**
 * File Panel Context — active file view state and callbacks
 *
 * Owns the transient (session-scoped) state for the file viewer: which file
 * is currently open, plus callbacks to open files and insert text into chat.
 * Separate from PreferencesContext because preferences are persistent user
 * settings; the active file view is ephemeral.
 *
 * @module FilePanelContext
 */

import { createContext, useContext, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useTransport } from './TransportContext.js';
import { useCwd } from '../hooks/useSessionCwd.js';
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
}

interface FilePanelContextValue {
  activeFileView: ActiveFileView | null;
  /** Whether the file viewer modal is open */
  fileModalOpen: boolean;
  /** Open a file in the file viewer modal */
  openFile: (relativePath: string, line?: number) => Promise<void>;
  /** Insert text into the chat input at cursor position */
  insertIntoChat: (text: string) => void;
  /** Register a callback to handle insertIntoChat. Called by TranscriptViewer. */
  registerInsertHandler: (handler: (text: string) => void) => void;
  /** Close the file viewer modal and clear active file */
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
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const { fullPath } = useCwd();
  const [activeFileView, setActiveFileView] = useState<ActiveFileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref-based insert handler — registered by TranscriptViewer, called by context menu commands.
  // Avoids prop-drilling through the component tree.
  const insertHandlerRef = useRef<((text: string) => void) | null>(null);

  const registerInsertHandler = useCallback((handler: (text: string) => void) => {
    insertHandlerRef.current = handler;
  }, []);

  const openFile = useCallback(async (relativePath: string) => {
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
      });
      // Open file viewer modal
      setFileModalOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Still open modal to show the error
      setFileModalOpen(true);
    } finally {
      setLoading(false);
    }
  }, [fullPath, transport]);

  const closeFile = useCallback(() => {
    setFileModalOpen(false);
    setActiveFileView(null);
    setError(null);
  }, []);

  const insertIntoChat = useCallback((text: string) => {
    insertHandlerRef.current?.(text);
  }, []);

  const value: FilePanelContextValue = useMemo(() => ({
    activeFileView,
    fileModalOpen,
    openFile,
    insertIntoChat,
    registerInsertHandler,
    closeFile,
    cwd: fullPath,
    loading,
    error,
  }), [activeFileView, fileModalOpen, openFile, insertIntoChat, registerInsertHandler, closeFile, fullPath, loading, error]);

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
