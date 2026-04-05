/**
 * TabContainerContext — provides a ref to the tab's outermost container div
 * and an `isActiveTab` flag for scoping global event listeners per-tab.
 *
 * Used to scope DOM queries (querySelector/querySelectorAll) to the current
 * tab's content area, preventing cross-tab element matches in multi-tab layouts.
 * In single-tab mode `isActiveTab` is always `true`; multi-tab hosts set it to
 * `false` for background tabs so global listeners (keyboard, paste, message)
 * only fire for the visible tab.
 *
 * @module webview/context/TabContainerContext
 */

import { createContext, useContext, useMemo, useRef } from 'react';
import { useTabControllerOptional } from './TabControllerContext.js';

interface TabContainerContextValue {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True when this tab is the currently focused/visible tab. Always true in single-tab mode. */
  isActiveTab: boolean;
}

const TabContainerContext = createContext<TabContainerContextValue | null>(null);

export function TabContainerProvider({ children, tabId }: { children: React.ReactNode; tabId?: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useTabControllerOptional();
  // Derive isActiveTab from the controller's activeTabId (reactive).
  // When activeTabId is null (not yet initialized), treat all tabs as active
  // so first-render effects (ResizeObservers, scroll listeners) can attach.
  const isActiveTab = tabId
    ? (controller?.activeTabId == null
      || controller.activeTabId === tabId
      || controller.lastActiveTranscriptTabId === tabId)
    : true;

  const value = useMemo(() => ({ containerRef, isActiveTab }), [isActiveTab]);

  return (
    <TabContainerContext.Provider value={value}>
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

/** Returns whether this tab is the currently active (visible) tab. */
export function useIsActiveTab(): boolean {
  const ctx = useContext(TabContainerContext);
  // Outside a TabContainerProvider (e.g. single-panel legacy mode) — always active.
  return ctx?.isActiveTab ?? true;
}
