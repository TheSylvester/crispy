/**
 * Control Panel Context — isolates control-panel-specific state from TranscriptViewer
 *
 * Holds state that the ControlPanel needs but the transcript rendering does NOT:
 * bypassEnabled, prefillInput, pendingAgencyMode, hasForkHistory, agencyMode,
 * and their associated callbacks.
 *
 * This prevents transcript entry re-renders when control panel state changes
 * (e.g. toggling bypass, typing in prefill, changing agency mode).
 *
 * Also exposes `agencyMode` so App.tsx can set `data-agency` on `.crispy-main`
 * without relying on CSS `:has()` selectors.
 *
 * @module context/ControlPanelContext
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type { AgencyMode } from '../components/control-panel/types.js';
import type { TranscriptEntry } from '../../core/transcript.js';

interface ControlPanelContextValue {
  /** Whether bypass permissions is enabled (for approval flow). */
  bypassEnabled: boolean;
  setBypassEnabled: (enabled: boolean) => void;

  /** Pre-fill content for the ChatInput (e.g. ExitPlanMode handoff). */
  prefillInput: { text: string; autoSend?: boolean } | null;
  setPrefillInput: (input: { text: string; autoSend?: boolean } | null) => void;
  /** Clear prefillInput after consumption. */
  consumePrefillInput: () => void;

  /** Pending agency mode push from ExitPlanMode handoff. */
  pendingAgencyMode: { agencyMode: AgencyMode; bypassEnabled: boolean } | null;
  setPendingAgencyMode: (mode: { agencyMode: AgencyMode; bypassEnabled: boolean } | null) => void;
  /** Clear pendingAgencyMode after consumption. */
  consumePendingAgencyMode: () => void;

  /** Whether fork history entries are loaded (for pre-display before session creation). */
  hasForkHistory: boolean;
  setHasForkHistory: (has: boolean) => void;

  /**
   * Handle fork history loaded — calls the registered setForkHistory handler
   * and sets hasForkHistory to true.
   */
  handleForkHistoryLoaded: (entries: TranscriptEntry[]) => void;

  /** Register the setForkHistory handler from useTranscript (called by TranscriptViewer on mount). */
  registerForkHistoryHandler: (handler: (entries: TranscriptEntry[]) => void) => void;

  /** Current agency mode from ControlPanel (for CSS data-agency on .crispy-main). */
  agencyMode: AgencyMode;
  setAgencyMode: (mode: AgencyMode) => void;
}

const ControlPanelCtx = createContext<ControlPanelContextValue | null>(null);

export function useControlPanel(): ControlPanelContextValue {
  const ctx = useContext(ControlPanelCtx);
  if (!ctx) throw new Error('useControlPanel must be used within ControlPanelProvider');
  return ctx;
}

interface ControlPanelProviderProps {
  children: React.ReactNode;
  /** When a real session is selected, clear fork history flag. */
  selectedSessionId: string | null;
}

export function ControlPanelProvider({
  children,
  selectedSessionId,
}: ControlPanelProviderProps): React.JSX.Element {
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [prefillInput, setPrefillInput] = useState<{ text: string; autoSend?: boolean } | null>(null);
  const [pendingAgencyMode, setPendingAgencyMode] = useState<{ agencyMode: AgencyMode; bypassEnabled: boolean } | null>(null);
  const [hasForkHistory, setHasForkHistory] = useState(false);
  const [agencyMode, setAgencyMode] = useState<AgencyMode>('ask-before-edits');

  const consumePrefillInput = useCallback(() => setPrefillInput(null), []);
  const consumePendingAgencyMode = useCallback(() => setPendingAgencyMode(null), []);

  // Fork history handler: registered by TranscriptViewer after useTranscript is called
  const forkHistoryHandlerRef = useRef<((entries: TranscriptEntry[]) => void) | null>(null);

  const registerForkHistoryHandler = useCallback((handler: (entries: TranscriptEntry[]) => void) => {
    forkHistoryHandlerRef.current = handler;
  }, []);

  const handleForkHistoryLoaded = useCallback((forkEntries: TranscriptEntry[]) => {
    forkHistoryHandlerRef.current?.(forkEntries);
    setHasForkHistory(true);
  }, []);

  // Clear fork history flag when a real session is selected
  useEffect(() => {
    if (selectedSessionId) {
      setHasForkHistory(false);
    }
  }, [selectedSessionId]);

  const value: ControlPanelContextValue = {
    bypassEnabled,
    setBypassEnabled,
    prefillInput,
    setPrefillInput,
    consumePrefillInput,
    pendingAgencyMode,
    setPendingAgencyMode,
    consumePendingAgencyMode,
    hasForkHistory,
    setHasForkHistory,
    handleForkHistoryLoaded,
    registerForkHistoryHandler,
    agencyMode,
    setAgencyMode,
  };

  return (
    <ControlPanelCtx.Provider value={value}>
      {children}
    </ControlPanelCtx.Provider>
  );
}
