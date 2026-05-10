/**
 * ErrorToast — error variant of the generic Toast.
 *
 * Owns the module-level pub/sub used by `pushErrorToast(msg)` (so any
 * component can surface an error from an event handler without prop
 * drilling). Rendering, animation, and dismiss timing live in
 * `Toast.tsx`; this module only defines the queue + variant.
 *
 * Same visual layer as TrackerToast (z-index 1000) but rendered on the
 * *left* edge — errors get attention without fighting tracker info on
 * the right.
 *
 * @module notifications/ErrorToast
 */

import { useState, useEffect } from 'react';
import { ToastContainer, TOAST_DISMISS_MS, type ToastItem } from './Toast.js';

export const ERROR_TOAST_DISMISS_MS = TOAST_DISMISS_MS;

interface ErrorToastEntry extends ToastItem {
  id: number;
}

type Listener = (toasts: ErrorToastEntry[]) => void;

let nextId = 1;
let toasts: ErrorToastEntry[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(toasts);
}

function dismiss(id: ToastItem['id']): void {
  const numericId = id as number;
  const timer = timers.get(numericId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(numericId);
  }
  if (!toasts.some((t) => t.id === numericId)) return;
  toasts = toasts.filter((t) => t.id !== numericId);
  emit();
}

/**
 * Push an error toast. Returns a function that dismisses it early.
 * Safe to call from anywhere (component event handlers, async callbacks).
 */
export function pushErrorToast(message: string): () => void {
  const id = nextId++;
  toasts = [...toasts, { id, icon: '⚠️', text: message }];
  emit();
  timers.set(id, setTimeout(() => dismiss(id), ERROR_TOAST_DISMISS_MS));
  return () => dismiss(id);
}

export function ErrorToast(): React.JSX.Element | null {
  const [items, setItems] = useState<ErrorToastEntry[]>(toasts);

  useEffect(() => {
    const listener: Listener = (next) => setItems(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return <ToastContainer items={items} variant="error" position="left" onDismiss={dismiss} />;
}
