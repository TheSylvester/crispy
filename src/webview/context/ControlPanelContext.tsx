/**
 * Control Panel Context — isolates control-panel-specific state from TranscriptViewer
 *
 * Holds state owned by the control panel layer: bypassEnabled, prefillInput,
 * pendingAgencyMode, agencyMode, and their callbacks. Also owns fork/rewind
 * preview state (previewEntries, hasForkHistory) — set by ControlPanel's
 * fork handler, read by TranscriptViewer for pre-send preview rendering.
 *
 * This prevents transcript entry re-renders when control panel state changes
 * (e.g. toggling bypass, typing in prefill, changing agency mode).
 *
 * Also exposes `agencyMode` so App.tsx can set `data-agency` on `.crispy-main`
 * without relying on CSS `:has()` selectors.
 *
 * @module context/ControlPanelContext
 */

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { AgencyMode } from '../components/control-panel/types.js';
import type { TranscriptEntry } from '../../core/transcript.js';

interface ControlPanelContextValue {
  /** Whether bypass permissions is enabled (for approval flow). */
  bypassEnabled: boolean;
  setBypassEnabled: (enabled: boolean) => void;

  /** Pre-fill content for the ChatInput (e.g. ExitPlanMode handoff). */
  prefillInput: { text: string; autoSend?: boolean; append?: boolean } | null;
  setPrefillInput: (input: { text: string; autoSend?: boolean; append?: boolean } | null) => void;
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
   * Fork/rewind preview entries — pre-send UI state, not live channel state.
   * Set by ControlPanel's fork/rewind handler, rendered by TranscriptViewer
   * when non-null (takes priority over useTranscript entries).
   * Cleared when the user sends (fork session is created and real catchup arrives).
   */
  previewEntries: TranscriptEntry[] | null;

  /**
   * Handle fork history loaded — sets previewEntries and hasForkHistory.
   */
  handleForkHistoryLoaded: (entries: TranscriptEntry[]) => void;

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
  const [prefillInput, setPrefillInput] = useState<{ text: string; autoSend?: boolean; append?: boolean } | null>(null);
  const [pendingAgencyMode, setPendingAgencyMode] = useState<{ agencyMode: AgencyMode; bypassEnabled: boolean } | null>(null);
  const [hasForkHistory, setHasForkHistory] = useState(false);
  const [previewEntries, setPreviewEntries] = useState<TranscriptEntry[] | null>(null);
  const [agencyMode, setAgencyMode] = useState<AgencyMode>('ask-before-edits');

  const consumePrefillInput = useCallback(() => setPrefillInput(null), []);
  const consumePendingAgencyMode = useCallback(() => setPendingAgencyMode(null), []);

  const handleForkHistoryLoaded = useCallback((forkEntries: TranscriptEntry[]) => {
    setPreviewEntries(forkEntries);
    setHasForkHistory(true);
  }, []);

  // Clear fork history flag and preview when a real (non-pending) session is
  // selected. Don't clear for pending: sessions — previewEntries must survive
  // through the pending phase until the catchup arrives with real entries.
  useEffect(() => {
    if (selectedSessionId && !selectedSessionId.startsWith('pending:')) {
      setHasForkHistory(false);
      setPreviewEntries(null);
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
    previewEntries,
    handleForkHistoryLoaded,
    agencyMode,
    setAgencyMode,
  };

  return (
    <ControlPanelCtx.Provider value={value}>
      {children}
    </ControlPanelCtx.Provider>
  );
}
