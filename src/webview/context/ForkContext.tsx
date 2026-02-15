/**
 * Fork Context — per-message fork button state
 *
 * Provides fork targets (user UUID → preceding assistant UUID mapping),
 * fork execution, and fork preview hover handlers to child components.
 *
 * useFork() returns null (not throw) when outside the provider, allowing
 * RichEntry to gracefully skip fork buttons in YAML/Compact modes.
 *
 * @module ForkContext
 */

import { createContext, useContext } from 'react';

interface ForkContextValue {
  onFork: (atMessageId: string) => void;
  onForkPreviewHover: (targetMessageId: string, hovering: boolean) => void;
  isStreaming: boolean;
  forkTargets: Map<string, string>; // user UUID → preceding assistant UUID
}

const ForkContext = createContext<ForkContextValue | null>(null);

interface ForkProviderProps extends ForkContextValue {
  children: React.ReactNode;
}

export function ForkProvider({ children, ...value }: ForkProviderProps): React.JSX.Element {
  return (
    <ForkContext.Provider value={value}>
      {children}
    </ForkContext.Provider>
  );
}

/**
 * Access fork state. Returns null if outside ForkProvider (graceful fallback).
 */
export function useFork(): ForkContextValue | null {
  return useContext(ForkContext);
}
