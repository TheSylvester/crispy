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
import type { TranscriptEntry } from '../../core/transcript.js';

export function useToolPanelAutoOpen(entries: TranscriptEntry[]): void {
  const { toolPanelOpen, toolPanelAutoOpen, setToolPanelOpen, setSidebarView } = usePreferences();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current || !toolPanelAutoOpen || toolPanelOpen) return;

    const hasToolUse = entries.some(
      (e) =>
        e.type === 'assistant' &&
        Array.isArray(e.message?.content) &&
        e.message!.content.some((b) => b.type === 'tool_use'),
    );

    if (hasToolUse) {
      // Skip on narrow viewports — panel would overlay content
      if (window.innerWidth < 800) return;
      setSidebarView('tools');
      setToolPanelOpen(true);
      firedRef.current = true;
    }
  }, [entries, toolPanelAutoOpen, toolPanelOpen, setToolPanelOpen, setSidebarView]);
}
