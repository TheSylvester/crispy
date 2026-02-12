/**
 * Transport Context — distributes the transport singleton via React context
 *
 * The transport is created once at startup (module singleton pattern) and
 * never changes. This context just distributes the stable reference.
 *
 * @module TransportContext
 */

import { createContext, useContext } from 'react';
import type { SessionService } from '../transport.js';

const TransportContext = createContext<SessionService | null>(null);

interface TransportProviderProps {
  transport: SessionService;
  children: React.ReactNode;
}

export function TransportProvider({ transport, children }: TransportProviderProps): React.JSX.Element {
  return (
    <TransportContext.Provider value={transport}>
      {children}
    </TransportContext.Provider>
  );
}

/**
 * Access the transport instance. Throws if used outside TransportProvider.
 */
export function useTransport(): SessionService {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error('useTransport must be used within a TransportProvider');
  }
  return transport;
}
