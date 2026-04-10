/**
 * Panel Opener — host-global panel creation/closure registry
 *
 * Allows any host module (webview-host, ipc-server) to open or close a UI
 * surface for an existing session. The actual panel management is
 * host-specific: VS Code registers createCrispyPanel, dev-server throws.
 *
 * @module panel-opener
 */

type PanelOpener = (sessionId: string, options?: { autoClose?: boolean }) => void;
type PanelCloser = (sessionId: string) => boolean;
let opener: PanelOpener | null = null;
let closer: PanelCloser | null = null;

export function registerPanelOpener(fn: PanelOpener): void {
  opener = fn;
}

export function registerPanelCloser(fn: PanelCloser): void {
  closer = fn;
}

export function openPanel(sessionId: string, options?: { autoClose?: boolean }): void {
  if (!opener) {
    throw new Error('No panel opener registered (headless mode?)');
  }
  opener(sessionId, options);
}

export function closePanel(sessionId: string): boolean {
  if (!closer) return false;
  return closer(sessionId);
}
