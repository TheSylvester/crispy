/**
 * TabContainerContext — provides a ref to the tab's outermost container div
 *
 * Used to scope DOM queries (querySelector/querySelectorAll) to the current
 * tab's content area, preventing cross-tab element matches in multi-tab layouts.
 *
 * @module webview/context/TabContainerContext
 */

import { createContext, useContext, useRef } from 'react';

interface TabContainerContextValue {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const TabContainerContext = createContext<TabContainerContextValue | null>(null);

export function TabContainerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <TabContainerContext.Provider value={{ containerRef }}>
      <div ref={containerRef} style={{ display: 'contents' }}>
        {children}
      </div>
    </TabContainerContext.Provider>
  );
}

export function useTabContainer(): TabContainerContextValue {
  const ctx = useContext(TabContainerContext);
  if (!ctx) throw new Error('useTabContainer must be used within TabContainerProvider');
  return ctx;
}
