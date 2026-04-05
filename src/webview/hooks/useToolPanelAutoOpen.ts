/**
 * Auto-open tool panel on first tool use — fires once per session mount.
 *
 * Watches transcript entries for the first tool_use block. When found,
 * opens the tool panel unless: the user already opened it, the preference
 * is off, or the viewport is too narrow (panel would overlay content).
 *
 * @module hooks/useToolPanelAutoOpen
 */

import { useRef, useEffect } from 'react';
import { usePreferences } from '../context/PreferencesContext.js';
import { useTabPanel } from '../context/TabPanelContext.js';
import { useTabContainer, useIsActiveTab } from '../context/TabContainerContext.js';
import type { TranscriptEntry } from '../../core/transcript.js';

export function useToolPanelAutoOpen(entries: TranscriptEntry[]): void {
  const { toolPanelAutoOpen } = usePreferences();
  const { toolPanelOpen, setToolPanelOpen, setSidebarView } = useTabPanel();
  const { containerRef } = useTabContainer();
  const isActiveTab = useIsActiveTab();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current || !toolPanelAutoOpen || toolPanelOpen || !isActiveTab) return;

    const hasToolUse = entries.some(
      (e) =>
        e.type === 'assistant' &&
        Array.isArray(e.message?.content) &&
        e.message!.content.some((b) => b.type === 'tool_use'),
    );

    if (hasToolUse) {
      // Skip on narrow containers — panel would overlay content
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      if (containerWidth < 800) return;
      setSidebarView('tools');
      setToolPanelOpen(true);
      firedRef.current = true;
    }
  }, [entries, toolPanelAutoOpen, toolPanelOpen, isActiveTab, setToolPanelOpen, setSidebarView, containerRef]);
}
