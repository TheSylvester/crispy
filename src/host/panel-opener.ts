/**
 * Panel Opener — host-global panel creation registry
 *
 * Allows any host module (webview-host, ipc-server) to open a new UI
 * surface for an existing session. The actual panel creation is
 * host-specific: VS Code registers createCrispyPanel, dev-server throws.
 *
 * @module panel-opener
 */

type PanelOpener = (sessionId: string) => void;
let opener: PanelOpener | null = null;

export function registerPanelOpener(fn: PanelOpener): void {
  opener = fn;
}

export function openPanel(sessionId: string): void {
  if (!opener) {
    throw new Error('No panel opener registered (headless mode?)');
  }
  opener(sessionId);
}
