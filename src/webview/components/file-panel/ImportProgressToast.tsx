/**
 * ImportProgressToast — bottom-right toast for the OS-drop import flow.
 *
 * Renders the in-flight copy progress and a Cancel button that signals the
 * daemon to stop at the next leaf boundary. Mounted by `OsDropOverlay`.
 *
 * @module file-panel/ImportProgressToast
 */

import type { ActiveImport } from '../../hooks/useOsDropDispatch.js';

interface Props {
  active: ActiveImport;
  onCancel: () => void;
}

function basename(p: string): string {
  if (!p) return '';
  const fwd = p.lastIndexOf('/');
  const back = p.lastIndexOf('\\');
  const idx = Math.max(fwd, back);
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function ImportProgressToast({ active, onCancel }: Props): React.JSX.Element {
  const total = Math.max(1, active.total);
  const pct = Math.min(100, Math.round((active.current / total) * 100));
  return (
    <div className="crispy-import-toast" role="status" aria-live="polite">
      <div className="crispy-import-toast__title">
        Copying… ({active.current}/{active.total})
      </div>
      <div className="crispy-import-toast__path" title={active.currentPath}>
        {basename(active.currentPath) || '\u00A0'}
      </div>
      <div className="crispy-import-toast__bar">
        <div className="crispy-import-toast__bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <button
        type="button"
        className="crispy-import-toast__cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
