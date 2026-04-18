/**
 * useOsDropDispatch — Tauri-only top-level OS drag-drop dispatcher.
 *
 * Subscribes to `tauri://drag-*` events from the native Tauri WebviewWindow
 * (enabled by removing `.disable_drag_drop_handler()` in lib.rs), hit-tests
 * the cursor against `data-drop-zone` elements in the DOM, and routes drops:
 *
 *   - `files-panel-folder` / `files-panel-root` → run preview/conflict/execute
 *     flow against the daemon import service.
 *   - `files-panel-file` → resolve to parent folder via `data-parent-path`.
 *   - `chat-input` → fire a `crispy:os-drop-files` CustomEvent on the target
 *     element so ControlPanel's existing handler can attach paths.
 *
 * Owns the host-side `subscribeImportProgress` lifecycle for the entire app
 * lifetime so individual Files Panels don't ref-count it.
 *
 * No-op outside Tauri (HTML5 drop continues to work in VS Code; browser/
 * cloud-relay have no OS to drop from).
 *
 * @module hooks/useOsDropDispatch
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import type { ImportPlan, ImportReport, Resolutions, ImportProgressEvent } from '../../core/import-types.js';

// IMPORT_PROGRESS_CHANNEL_ID is duplicated here as a string literal to avoid
// pulling host-side types into the webview bundle. Keep in sync with
// `host/client-connection.ts`.
const IMPORT_PROGRESS_CHANNEL_ID = '__import_progress__';

/**
 * Tauri 2.x `tauri://drag-drop` payload shape. Inlined here to avoid eagerly
 * pulling `@tauri-apps/api` types into the bundle just for this declaration.
 * Position is in physical (device) pixels — divide by `devicePixelRatio` to
 * use with `document.elementFromPoint`.
 */
type TauriDragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

const DEDUP_WINDOW_MS = 500;

// ============================================================================
// Public state shape — what FilePanel UI listens to via context.
// ============================================================================

export interface PendingImport {
  plan: ImportPlan;
  cwd: string;
  destRelDir: string;
  resolve: (resolutions: Resolutions | null) => void;
}

export interface ActiveImport {
  planId: string;
  cwd: string;
  destRelDir: string;
  total: number;
  current: number;
  currentPath: string;
}

export interface OsDropState {
  pending: PendingImport | null;
  active: ActiveImport | null;
  cancel: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useOsDropDispatch(): OsDropState {
  const transport = useTransport();
  const transportKind = useEnvironment();
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [active, setActive] = useState<ActiveImport | null>(null);
  // `inFlightRef` is per-window: a second Tauri window on the same project
  // would have its own ref. Cross-window coordination would have to live in
  // the host's `clientOwnedPlans` set, but in v1 each shell user has one
  // window so the per-window guard is sufficient.
  const inFlightRef = useRef(false);
  const lastDropRef = useRef<{ sig: string; ts: number } | null>(null);
  const lastTargetRef = useRef<HTMLElement | null>(null);
  const hitTestPendingRef = useRef(false);
  // `cancel` reads `active` through a ref so its identity stays stable across
  // the 10-fps progress re-renders, letting downstream memoised consumers
  // skip work.
  const activeRef = useRef<ActiveImport | null>(null);
  activeRef.current = active;

  const cancel = useCallback(() => {
    const a = activeRef.current;
    if (a) {
      void transport.cancelImport({ planId: a.planId }).catch(() => {});
    }
  }, [transport]);

  // Subscribe to the per-client import-progress channel for the app lifetime.
  useEffect(() => {
    if (transportKind !== 'tauri') return;
    void transport.subscribeImportProgress().catch(() => {});
    const unsub = transport.onEvent((sessionId, event) => {
      if (sessionId !== IMPORT_PROGRESS_CHANNEL_ID) return;
      if ((event as ImportProgressEvent).type !== 'import-progress') return;
      const e = event as ImportProgressEvent;
      setActive((prev) => {
        if (!prev || prev.planId !== e.planId) return prev;
        if (e.done) return null;
        // Skip identical-frame updates so consumers don't re-render on a
        // throttled-but-unchanged tick.
        if (
          prev.current === e.current &&
          prev.total === e.total &&
          prev.currentPath === e.currentPath
        ) {
          return prev;
        }
        return {
          ...prev,
          total: e.total,
          current: e.current,
          currentPath: e.currentPath,
        };
      });
    });
    return () => {
      unsub();
      void transport.unsubscribeImportProgress().catch(() => {});
    };
  }, [transport, transportKind]);

  // Subscribe to native Tauri drag-drop events.
  useEffect(() => {
    if (transportKind !== 'tauri') return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    function clearTarget(): void {
      const t = lastTargetRef.current;
      if (t && t.hasAttribute('data-drop-target')) {
        t.removeAttribute('data-drop-target');
      }
      lastTargetRef.current = null;
    }

    function applyTarget(el: HTMLElement | null): void {
      if (lastTargetRef.current === el) return;
      clearTarget();
      if (!el) return;
      el.setAttribute('data-drop-target', '');
      lastTargetRef.current = el;
    }

    function hitTest(physX: number, physY: number): HTMLElement | null {
      const dpr = window.devicePixelRatio || 1;
      const x = physX / dpr;
      const y = physY / dpr;
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return null;
      return el.closest<HTMLElement>('[data-drop-zone]');
    }

    function handleOver(physX: number, physY: number): void {
      if (hitTestPendingRef.current) return;
      hitTestPendingRef.current = true;
      requestAnimationFrame(() => {
        hitTestPendingRef.current = false;
        const zoneEl = hitTest(physX, physY);
        // For files-panel-file, highlight the parent folder row instead.
        let highlightEl = zoneEl;
        if (zoneEl?.getAttribute('data-drop-zone') === 'files-panel-file') {
          const parentPath = zoneEl.getAttribute('data-parent-path') ?? '';
          if (parentPath) {
            const parentEl = document.querySelector<HTMLElement>(
              `[data-drop-zone="files-panel-folder"][data-path="${CSS.escape(parentPath)}"]`,
            );
            if (parentEl) highlightEl = parentEl;
          } else {
            // Top-level file → highlight the panel root.
            const root = zoneEl.closest<HTMLElement>('[data-drop-zone="files-panel-root"]');
            if (root) highlightEl = root;
          }
        }
        applyTarget(highlightEl);
      });
    }

    async function handleDrop(physX: number, physY: number, paths: string[]): Promise<void> {
      clearTarget();

      // Tauri 2.x can fire duplicate drop events — dedupe by sorted-path signature.
      const sig = paths.slice().sort().join('|');
      const now = Date.now();
      const last = lastDropRef.current;
      if (last && last.sig === sig && now - last.ts < DEDUP_WINDOW_MS) return;
      lastDropRef.current = { sig, ts: now };

      const zoneEl = hitTest(physX, physY);
      if (!zoneEl) return;
      const zone = zoneEl.getAttribute('data-drop-zone');

      // ---- Chat input branch ----
      if (zone === 'chat-input') {
        zoneEl.dispatchEvent(
          new CustomEvent('crispy:os-drop-files', { detail: { paths }, bubbles: true }),
        );
        return;
      }

      // ---- Files-panel branches ----
      if (zone === 'files-panel-root' || zone === 'files-panel-folder' || zone === 'files-panel-file') {
        if (inFlightRef.current) {
          // Surface a transient hint via the same custom event mechanism.
          zoneEl.dispatchEvent(
            new CustomEvent('crispy:import-busy', { bubbles: true }),
          );
          return;
        }

        let targetEl: HTMLElement | null = zoneEl;
        let destRelDir = '';
        if (zone === 'files-panel-folder') {
          destRelDir = zoneEl.getAttribute('data-path') ?? '';
        } else if (zone === 'files-panel-file') {
          destRelDir = zoneEl.getAttribute('data-parent-path') ?? '';
          targetEl = zoneEl.closest<HTMLElement>('[data-drop-zone="files-panel-root"]');
        }
        const rootEl = zoneEl.closest<HTMLElement>('[data-drop-zone="files-panel-root"]') ?? targetEl;
        const cwd = rootEl?.getAttribute('data-cwd') ?? '';
        const sessionId = rootEl?.getAttribute('data-session-id') ?? undefined;
        if (!cwd) return;

        inFlightRef.current = true;
        try {
          const plan = await transport.previewImport({
            sessionId,
            projectCwdHint: cwd,
            destRelDir,
            srcs: paths,
          });

          if (plan.conflicts.length === 0 && plan.errors.length === 0) {
            await runExecute(plan, cwd, destRelDir, {});
            return;
          }

          if (plan.errors.length > 0 && plan.summary.fileCount === 0 && plan.conflicts.length === 0) {
            // Nothing copyable — surface the error to devs + the file index so
            // users don't see a silent no-op (the most common real-world hit is
            // Tauri Windows shell + WSL daemon delivering Windows paths that
            // the Linux daemon can't `lstat`).
            const firstError = plan.errors[0];
            const message = firstError
              ? `${firstError.code}: ${firstError.message}`
              : 'Import failed with no copyable files';
            console.warn('[useOsDropDispatch] import aborted:', message, plan.errors);
            window.dispatchEvent(new CustomEvent('crispy:import-failed', {
              detail: { error: message, cwd, destRelDir, errors: plan.errors },
            }));
            return;
          }

          if (plan.conflicts.length > 0) {
            const resolutions = await openConflictModal(plan, cwd, destRelDir);
            if (!resolutions) return; // user cancelled
            await runExecute(plan, cwd, destRelDir, resolutions);
          } else {
            // Errors present but some files copyable — proceed with empty resolutions.
            await runExecute(plan, cwd, destRelDir, {});
          }
        } finally {
          inFlightRef.current = false;
        }
      }
    }

    function openConflictModal(plan: ImportPlan, cwd: string, destRelDir: string): Promise<Resolutions | null> {
      return new Promise<Resolutions | null>((resolve) => {
        setPending({ plan, cwd, destRelDir, resolve });
      });
    }

    async function runExecute(plan: ImportPlan, cwd: string, destRelDir: string, resolutions: Resolutions): Promise<void> {
      setActive({
        planId: plan.planId,
        cwd,
        destRelDir,
        total: plan.summary.fileCount + plan.summary.symlinkCount,
        current: 0,
        currentPath: '',
      });
      try {
        const report: ImportReport = await transport.executeImport({
          planId: plan.planId,
          resolutions,
        });
        window.dispatchEvent(new CustomEvent('crispy:import-done', {
          detail: { report, cwd, destRelDir },
        }));
      } catch (err) {
        window.dispatchEvent(new CustomEvent('crispy:import-failed', {
          detail: { error: err instanceof Error ? err.message : String(err), cwd, destRelDir },
        }));
      } finally {
        setActive(null);
      }
    }

    (async () => {
      try {
        const webviewMod = await import('@tauri-apps/api/webview');
        const wv = webviewMod.getCurrentWebview();
        const stop = await wv.onDragDropEvent((evt: { payload: TauriDragDropPayload }) => {
          const payload = evt.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            handleOver(payload.position.x, payload.position.y);
          } else if (payload.type === 'leave') {
            clearTarget();
          } else if (payload.type === 'drop') {
            void handleDrop(payload.position.x, payload.position.y, payload.paths);
          }
        });
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      } catch (err) {
        // Tauri API not available (e.g. running outside Tauri shell despite
        // transportKind === 'tauri'). Silently no-op.
        console.warn('[useOsDropDispatch] failed to subscribe to Tauri drag-drop events:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      clearTarget();
    };
  }, [transport, transportKind]);

  return { pending, active, cancel };
}
