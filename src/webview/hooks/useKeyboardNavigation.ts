/**
 * useKeyboardNavigation — keyboard focus management for list navigation
 *
 * Manages a flat focus index across a list of items. Handles ArrowUp/Down
 * for movement, Enter for selection, and Escape for dismissal. Focus is
 * clamped (does not wrap). Scrolls the focused item into view.
 *
 * Does NOT manage what the items are — that's the caller's responsibility.
 * Group headers are not counted in the index; only selectable items are.
 *
 * @module useKeyboardNavigation
 */

import { useState, useCallback, useEffect } from 'react';
import type { RefObject, KeyboardEvent } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface UseKeyboardNavigationOptions {
  totalItems: number;
  onSelect: (index: number) => void;
  onEscape: () => void;
  listRef: RefObject<HTMLElement | null>;
}

export interface UseKeyboardNavigationReturn {
  focusIndex: number;
  setFocusIndex: (index: number) => void;
  handleKeyDown: (e: KeyboardEvent) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useKeyboardNavigation(
  opts: UseKeyboardNavigationOptions,
): UseKeyboardNavigationReturn {
  const [focusIndex, setFocusIndex] = useState(-1);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex(prev => Math.min(prev + 1, opts.totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        if (focusIndex >= 0) {
          opts.onSelect(focusIndex);
        }
        break;
      case 'Escape':
        opts.onEscape();
        break;
    }
  }, [focusIndex, opts.totalItems, opts.onSelect, opts.onEscape]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex < 0 || !opts.listRef.current) return;
    const target = opts.listRef.current.querySelector(
      `[data-session-index="${focusIndex}"]`
    ) as HTMLElement | null;
    target?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, opts.listRef]);

  return { focusIndex, setFocusIndex, handleKeyDown };
}
