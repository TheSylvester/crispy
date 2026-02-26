/**
 * Theme Kind Hook — reactive VS Code theme detection
 *
 * Reads `document.body.dataset.vscodeThemeKind` (set by VS Code or the dev
 * server bootstrap) and re-renders when it changes. Uses MutationObserver
 * on `<body>` attributes + useSyncExternalStore for tear-free reads.
 *
 * Does NOT create a React context — just a hook. Components that need theme
 * awareness call useThemeKind() directly.
 *
 * @module webview/hooks/useThemeKind
 */

import { useSyncExternalStore } from 'react';

export type ThemeKind = 'vscode-dark' | 'vscode-light' | 'vscode-high-contrast' | 'vscode-high-contrast-light';

const DEFAULT: ThemeKind = 'vscode-dark';

let cached: ThemeKind = readThemeKind();
const listeners = new Set<() => void>();

function readThemeKind(): ThemeKind {
  return (document.body.dataset.vscodeThemeKind as ThemeKind) || DEFAULT;
}

function subscribe(cb: () => void): () => void {
  // Bootstrap on first subscriber
  if (listeners.size === 0) {
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) observer.disconnect();
  };
}

function getSnapshot(): ThemeKind {
  return cached;
}

const observer = new MutationObserver(() => {
  const next = readThemeKind();
  if (next !== cached) {
    cached = next;
    for (const cb of listeners) cb();
  }
});

/** Reactive VS Code theme kind. Re-renders on theme switch. */
export function useThemeKind(): ThemeKind {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** True for vscode-light and vscode-high-contrast-light. */
export function isLightTheme(kind: ThemeKind): boolean {
  return kind === 'vscode-light' || kind === 'vscode-high-contrast-light';
}
