import React, { createContext, useContext } from 'react';

/**
 * RenderLocation — identifies where a component is being rendered.
 * - 'transcript': the main scrollable transcript area (summary-first)
 * - 'panel': the dedicated tool detail panel (detail-rich)
 */
export type RenderLocation = 'transcript' | 'panel';

const RenderLocationContext = createContext<RenderLocation>('transcript');

export function RenderLocationProvider({
  location,
  children,
}: {
  location: RenderLocation;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <RenderLocationContext.Provider value={location}>
      {children}
    </RenderLocationContext.Provider>
  );
}

export function useRenderLocation(): RenderLocation {
  return useContext(RenderLocationContext);
}
