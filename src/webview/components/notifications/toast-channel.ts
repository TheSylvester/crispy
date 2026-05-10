/**
 * toast-channel — generic queue + auto-dismiss + pub/sub for toast variants.
 *
 * Owns the pieces both ErrorToast (module pub/sub) and TrackerToast
 * (transport-event-driven hook) used to duplicate: push-to-queue, set
 * dismiss timer, click-dismiss cancels timer, fan out item snapshots to
 * subscribers. Variants supply only their own item shape and event source.
 *
 * @module notifications/toast-channel
 */

import { useEffect, useState } from 'react';
import { TOAST_DISMISS_MS } from './Toast.js';

export interface ToastChannel<T extends { id: number | string }> {
  push: (item: T) => () => void;
  dismiss: (id: T['id']) => void;
  subscribe: (fn: (items: readonly T[]) => void) => () => void;
  getItems: () => readonly T[];
}

export function createToastChannel<T extends { id: number | string }>(
  dismissMs: number = TOAST_DISMISS_MS,
): ToastChannel<T> {
  let items: T[] = [];
  const timers = new Map<T['id'], ReturnType<typeof setTimeout>>();
  const listeners = new Set<(items: readonly T[]) => void>();

  const emit = (): void => {
    for (const l of listeners) l(items);
  };

  const dismiss = (id: T['id']): void => {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    if (!items.some((i) => i.id === id)) return;
    items = items.filter((i) => i.id !== id);
    emit();
  };

  const push = (item: T): (() => void) => {
    items = [...items, item];
    emit();
    timers.set(item.id, setTimeout(() => dismiss(item.id), dismissMs));
    return () => dismiss(item.id);
  };

  const subscribe = (fn: (items: readonly T[]) => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  return { push, dismiss, subscribe, getItems: () => items };
}

/** React mirror of a ToastChannel — re-renders on push/dismiss. */
export function useToastChannel<T extends { id: number | string }>(
  channel: ToastChannel<T>,
): { items: readonly T[]; dismiss: (id: T['id']) => void } {
  const [items, setItems] = useState<readonly T[]>(channel.getItems());
  useEffect(() => channel.subscribe(setItems), [channel]);
  return { items, dismiss: channel.dismiss };
}
