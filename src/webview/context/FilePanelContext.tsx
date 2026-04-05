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

import { createContext, useContext, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useTransport } from './TransportContext.js';
import { useTabSession } from './TabSessionContext.js';
import { useTabControllerOptional } from './TabControllerContext.js';
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
  const { effectiveCwd } = useTabSession();
  const fullPath = effectiveCwd.fullPath;
  const tabController = useTabControllerOptional();
  // Track selected file path for tree highlighting
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // Ref-based insert handler — registered by TranscriptViewer, called by context menu commands.
  // Avoids prop-drilling through the component tree.
  const insertHandlerRef = useRef<((text: string) => void) | null>(null);

  const registerInsertHandler = useCallback((handler: (text: string) => void) => {
    insertHandlerRef.current = handler;
  }, []);

  const openFileAsTab = useCallback((absolutePath: string, relativePath: string, line?: number) => {
    setSelectedFilePath(relativePath);

    if (tabController) {
      const existing = tabController.findFileViewerTab(absolutePath);
      if (existing) {
        tabController.activateTab(existing);
        if (line != null) {
          tabController.updateTabConfig(existing, { path: absolutePath, line });
        }
        return;
      }
      const filename = relativePath.split('/').pop() ?? relativePath;
      tabController.createTab({
        component: 'file-viewer',
        name: filename,
        config: { path: absolutePath, line },
      });
    }
  }, [tabController]);

  const openFile = useCallback(async (relativePath: string, line?: number) => {
    if (!fullPath) return;
    const absolutePath = `${fullPath}/${relativePath}`;
    openFileAsTab(absolutePath, relativePath, line);
  }, [fullPath, openFileAsTab]);

  const openFileAbsolute = useCallback(async (absolutePath: string, line?: number) => {
    let relativePath: string;
    if (fullPath && absolutePath.startsWith(fullPath + '/')) {
      relativePath = absolutePath.slice(fullPath.length + 1);
    } else {
      relativePath = absolutePath.split('/').pop() ?? absolutePath;
    }
    openFileAsTab(absolutePath, relativePath, line);
  }, [fullPath, openFileAsTab]);

  const insertIntoChat = useCallback((text: string) => {
    // Try ref-based handler first (works within same tab's FilePanelProvider),
    // fall back to postMessage for border panel → transcript tab communication
    if (insertHandlerRef.current) {
      insertHandlerRef.current(text);
    } else {
      window.postMessage({ kind: 'insertIntoChat', text }, '*');
    }
  }, []);

  const value: FilePanelContextValue = useMemo(() => ({
    activeFileView: selectedFilePath ? { relativePath: selectedFilePath } as ActiveFileView : null,
    fileViewerOpen: false,
    openFile,
    openFileAbsolute,
    insertIntoChat,
    registerInsertHandler,
    closeFile: () => {},
    cwd: fullPath,
    loading: false,
    error: null,
  }), [selectedFilePath, openFile, openFileAbsolute, insertIntoChat, registerInsertHandler, fullPath]);

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
