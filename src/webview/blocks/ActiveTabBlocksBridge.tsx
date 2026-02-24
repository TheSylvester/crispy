/**
 * ActiveTabBlocksBridge — writes the active tab's provider context values
 * to the shared ActiveTabBlocks bridge.
 *
 * Must be rendered INSIDE the per-tab providers so it can read from them.
 * Only writes when isActiveTab=true. Uses useLayoutEffect to ensure sibling
 * panels (Inspector, etc.) see the new tab's values before paint.
 *
 * @module ActiveTabBlocksBridge
 */

import { useContext, useLayoutEffect } from 'react';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { usePanelState, usePanelDispatch, usePanelDisplayIds, useSetPanelDisplayIds } from './PanelStateContext.js';
import { useBlocksVisibilityStore } from './BlocksVisibilityContext.js';
import { ActiveTabBlocksSettersCtx } from './ActiveTabBlocksContext.js';

export function ActiveTabBlocksBridge({
  isActiveTab,
  scrollRef,
  sessionId,
}: {
  isActiveTab: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string | null;
}): null {
  const setters = useContext(ActiveTabBlocksSettersCtx);

  // Read from per-tab providers (direct context access, not the fallback hooks)
  const registry = useBlocksToolRegistry();
  const panelState = usePanelState();
  const panelDispatch = usePanelDispatch();
  const panelDisplayIds = usePanelDisplayIds();
  const setPanelDisplayIds = useSetPanelDisplayIds();
  const visibilityStore = useBlocksVisibilityStore();

  // Write to bridge only when this is the active tab.
  // useLayoutEffect ensures sibling panels (Inspector, etc.) see
  // the new tab's values before the browser paints, eliminating the single-frame
  // gap where they would read stale data from the previously active tab.
  useLayoutEffect(() => {
    if (!isActiveTab || !setters) return;

    setters.setRegistry(registry);
    setters.setSessionId(sessionId);
    setters.setPanelState(panelState);
    setters.setPanelDispatch(panelDispatch);
    setters.setPanelDisplayIds(setPanelDisplayIds);
    setters.setBridgePanelDisplayIds(panelDisplayIds);
    setters.setVisibilityStore(visibilityStore);
    setters.setScrollRef(scrollRef);
  }, [
    isActiveTab,
    setters,
    registry,
    sessionId,
    panelState,
    panelDispatch,
    panelDisplayIds,
    setPanelDisplayIds,
    visibilityStore,
    scrollRef,
  ]);

  return null;
}
