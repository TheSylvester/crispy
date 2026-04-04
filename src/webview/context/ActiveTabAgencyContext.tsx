/**
 * ActiveTabAgencyContext — bridge for per-tab agencyMode to App-level consumers
 *
 * The active tab's ControlPanelProvider pushes its agencyMode here so
 * AgencyMain (which sits above the tab layer) can read it for
 * data-agency on .crispy-main.
 *
 * @module context/ActiveTabAgencyContext
 */

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { AgencyMode } from '../components/control-panel/types.js';

interface ActiveTabAgencyValue {
  agencyMode: AgencyMode;
  setAgencyMode: (mode: AgencyMode) => void;
}

const ActiveTabAgencyCtx = createContext<ActiveTabAgencyValue | null>(null);

export function ActiveTabAgencyProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [agencyMode, setAgencyModeRaw] = useState<AgencyMode>('ask-before-edits');
  const setAgencyMode = useCallback((m: AgencyMode) => setAgencyModeRaw(m), []);
  const value = useMemo(() => ({ agencyMode, setAgencyMode }), [agencyMode, setAgencyMode]);

  return (
    <ActiveTabAgencyCtx.Provider value={value}>
      {children}
    </ActiveTabAgencyCtx.Provider>
  );
}

export function useActiveTabAgency(): ActiveTabAgencyValue {
  const ctx = useContext(ActiveTabAgencyCtx);
  if (!ctx) throw new Error('useActiveTabAgency must be used within ActiveTabAgencyProvider');
  return ctx;
}
