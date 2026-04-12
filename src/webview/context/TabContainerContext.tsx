/**
 * TabContainerContext — provides a ref to the tab's outermost container div,
 * an `isActiveTab` flag for scoping global event listeners per-tab, and
 * `isDomVisible` driven by FlexLayout's native TabNode visibility API.
 *
 * `isDomVisible` is the ground truth for whether this tab's DOM is actually
 * rendered (not display:none). It correctly handles splits, maximized tabsets,
 * and all FlexLayout layouts. Use it for observers/listeners that depend on
 * DOM visibility (scroll, resize). Use `isActiveTab` (sticky last-active-
 * transcript-tab) for input routing (keyboard, paste, message).
 *
 * @module webview/context/TabContainerContext
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { TabNode } from 'flexlayout-react';
import { useTabControllerOptional } from './TabControllerContext.js';

interface TabContainerContextValue {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True when this tab is the currently focused/visible tab OR the last active transcript tab
   *  (sticky — stays true when a non-transcript tab like a file viewer is selected).
   *  Use for input routing: keyboard events, chat inserts, file-panel actions. */
  isActiveTab: boolean;
  /** True when FlexLayout reports this tab's DOM is rendered (not display:none).
   *  Correctly handles split layouts where multiple tabs are visible simultaneously.
   *  Use for scroll save/restore, ResizeObservers, IntersectionObservers. */
  isDomVisible: boolean;
  /** Register a callback to fire synchronously BEFORE display:none is applied.
   *  This is the only moment where scrollTop is still valid for saving.
   *  Pass null to unregister. */
  registerOnBeforeHide: (cb: (() => void) | null) => void;
}

const TabContainerContext = createContext<TabContainerContextValue | null>(null);

export function TabContainerProvider({ children, tabId, tabNode }: { children: React.ReactNode; tabId?: string; tabNode?: TabNode }): React.JSX.Element {
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

  // --- FlexLayout native DOM visibility ---
  const [isDomVisible, setIsDomVisible] = useState(() => tabNode?.isVisible() ?? true);
  const onBeforeHideRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!tabNode) return;
    setIsDomVisible(tabNode.isVisible()); // seed
    const handler = ({ visible }: { visible: boolean }) => {
      // CRITICAL: Save scroll position SYNCHRONOUSLY in this handler.
      // FlexLayout fires setVisible(false) BEFORE React commits display:none to DOM.
      // This is the ONLY moment where scrollTop is still valid. By the time any
      // React effect processes the state change, scrollTop is already 0.
      if (!visible) onBeforeHideRef.current?.();
      setIsDomVisible(visible);
    };
    tabNode.setEventListener("visibility", handler);
    return () => tabNode.removeEventListener("visibility");
  }, [tabNode]);

  const registerOnBeforeHide = useCallback((cb: (() => void) | null) => {
    onBeforeHideRef.current = cb;
  }, []);

  const value = useMemo(
    () => ({ containerRef, isActiveTab, isDomVisible, registerOnBeforeHide }),
    [isActiveTab, isDomVisible, registerOnBeforeHide],
  );

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

/** Returns FlexLayout ground-truth DOM visibility.
 *  True for ALL visible tabs in split layouts. */
export function useIsDomVisible(): boolean {
  const ctx = useContext(TabContainerContext);
  return ctx?.isDomVisible ?? true;
}

/** Returns the registerOnBeforeHide callback for saving state before display:none. */
export function useRegisterOnBeforeHide(): (cb: (() => void) | null) => void {
  const ctx = useContext(TabContainerContext);
  return ctx?.registerOnBeforeHide ?? NOOP_REGISTER;
}

const NOOP_REGISTER = (_cb: (() => void) | null): void => {};
