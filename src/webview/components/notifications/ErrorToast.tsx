/**
 * ErrorToast — error variant of the generic Toast.
 *
 * Owns a module-level `ToastChannel` so any code can call `pushErrorToast`
 * from outside the React tree. Queue, auto-dismiss timer, click-dismiss,
 * and subscriber fan-out live in `toast-channel.ts`; rendering and
 * animation live in `Toast.tsx`. This module only assigns the variant +
 * a stable id source and keeps the public push API.
 *
 * Same visual layer as TrackerToast (z-index 1000) but rendered on the
 * *left* edge — errors get attention without fighting tracker info on
 * the right.
 *
 * @module notifications/ErrorToast
 */

import { ToastContainer, TOAST_DISMISS_MS, type ToastItem } from './Toast.js';
import { createToastChannel, useToastChannel } from './toast-channel.js';

export const ERROR_TOAST_DISMISS_MS = TOAST_DISMISS_MS;

interface ErrorToastEntry extends ToastItem {
  id: number;
}

const channel = createToastChannel<ErrorToastEntry>();
let nextId = 1;

/**
 * Push an error toast. Returns a function that dismisses it early.
 * Safe to call from anywhere (component event handlers, async callbacks).
 */
export function pushErrorToast(message: string): () => void {
  return channel.push({ id: nextId++, icon: '⚠️', text: message });
}

export function ErrorToast(): React.JSX.Element | null {
  const { items, dismiss } = useToastChannel(channel);
  return (
    <ToastContainer
      items={items}
      variant="error"
      position="left"
      onDismiss={(id) => dismiss(id as number)}
    />
  );
}
