/**
 * Environment Context — transport kind for environment-aware rendering
 *
 * Simple context holding the transport kind ('vscode' | 'websocket').
 * Avoids refactoring every useTransport() consumer to thread environment info.
 *
 * @module EnvironmentContext
 */

import { createContext, useContext } from 'react';
import type { TransportKind } from '../main.js';

const EnvironmentContext = createContext<TransportKind | null>(null);

interface EnvironmentProviderProps {
  kind: TransportKind;
  children: React.ReactNode;
}

export function EnvironmentProvider({ kind, children }: EnvironmentProviderProps): React.JSX.Element {
  return (
    <EnvironmentContext.Provider value={kind}>
      {children}
    </EnvironmentContext.Provider>
  );
}

/**
 * Access the transport kind ('vscode' | 'websocket').
 * Throws if used outside EnvironmentProvider.
 */
export function useEnvironment(): TransportKind {
  const kind = useContext(EnvironmentContext);
  if (!kind) {
    throw new Error('useEnvironment must be used within an EnvironmentProvider');
  }
  return kind;
}
