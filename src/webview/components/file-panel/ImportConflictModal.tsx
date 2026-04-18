/**
 * ImportConflictModal — resolve OS-drop import conflicts
 *
 * Renders one row per conflict with a per-row action picker (Replace / Skip /
 * Auto-rename), plus a "do this for all" bulk-action selector that, when
 * applied, fills in any rows still on the default. Cancel aborts the entire
 * import (no partial copy). Submit returns a `Resolutions` map.
 *
 * Mounted by `OsDropOverlay` at the app root; opened/closed by
 * `useOsDropDispatch`.
 *
 * @module file-panel/ImportConflictModal
 */

import { useMemo, useState } from 'react';
import type { ConflictItem, Resolution, Resolutions } from '../../../core/import-types.js';
import { formatBytes } from '../../utils/format.js';

interface Props {
  conflicts: ConflictItem[];
  destRelDir: string;
  onSubmit: (resolutions: Resolutions) => void;
  onCancel: () => void;
}

const ACTIONS: Array<{ value: Resolution; label: string }> = [
  { value: 'replace', label: 'Replace' },
  { value: 'skip', label: 'Skip' },
  { value: 'rename', label: 'Auto-rename' },
];

function formatTime(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

export function ImportConflictModal({
  conflicts,
  destRelDir,
  onSubmit,
  onCancel,
}: Props): React.JSX.Element {
  // Per-row picks; rows without an explicit pick fall back to bulk action.
  const [picks, setPicks] = useState<Resolutions>({});
  const [bulk, setBulk] = useState<Resolution>('replace');

  const resolved = useMemo<Resolutions>(() => {
    const out: Resolutions = {};
    for (const c of conflicts) {
      out[c.id] = picks[c.id] ?? bulk;
    }
    return out;
  }, [conflicts, picks, bulk]);

  const destLabel = destRelDir ? `./${destRelDir}` : './';

  return (
    <div
      className="crispy-import-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="crispy-import-modal-title"
    >
      <div className="crispy-import-modal">
        <header className="crispy-import-modal__header">
          <h2 id="crispy-import-modal-title">
            {conflicts.length} file{conflicts.length === 1 ? '' : 's'} already exist in {destLabel}
          </h2>
        </header>

        <div className="crispy-import-modal__bulk">
          <label>
            Apply to all:
            <select
              value={bulk}
              onChange={(e) => setBulk(e.target.value as Resolution)}
            >
              {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
        </div>

        <div className="crispy-import-modal__list">
          <div className="crispy-import-modal__row crispy-import-modal__row--header">
            <span>File</span>
            <span>Existing</span>
            <span>New</span>
            <span>Action</span>
          </div>
          {conflicts.map((c) => (
            <div className="crispy-import-modal__row" key={c.id}>
              <span className="crispy-import-modal__path" title={c.destPath}>
                {c.destRelPath}
              </span>
              <span className="crispy-import-modal__meta">
                {formatBytes(c.destSize)}<br />
                <span className="crispy-import-modal__sub">{formatTime(c.destMtimeMs)}</span>
              </span>
              <span className="crispy-import-modal__meta">
                {formatBytes(c.srcSize)}<br />
                <span className="crispy-import-modal__sub">{formatTime(c.srcMtimeMs)}</span>
              </span>
              <span>
                <select
                  value={picks[c.id] ?? bulk}
                  onChange={(e) => setPicks(prev => ({ ...prev, [c.id]: e.target.value as Resolution }))}
                  aria-label={`Action for ${c.destRelPath}`}
                >
                  {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </span>
            </div>
          ))}
        </div>

        <footer className="crispy-import-modal__footer">
          <button type="button" onClick={onCancel} className="crispy-import-modal__btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(resolved)}
            className="crispy-import-modal__btn crispy-import-modal__btn--primary"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
