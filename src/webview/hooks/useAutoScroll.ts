/**
 * useAutoScroll — GUTTED. All scroll logic removed pending a working replacement.
 *
 * Returns inert values so callers compile without changes.
 *
 * @module useAutoScroll
 */

export interface UseAutoScrollOptions {
  sessionId: string | null;
}

export interface UseAutoScrollReturn {
  isSticky: boolean;
  isAtTop: boolean;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  pinToBottom: () => void;
}

const noop = () => {};

export function useAutoScroll(_opts: UseAutoScrollOptions): UseAutoScrollReturn {
  return {
    isSticky: true,
    isAtTop: false,
    scrollToBottom: noop,
    scrollToTop: noop,
    pinToBottom: noop,
  };
}
