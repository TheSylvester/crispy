/**
 * OsDropOverlay — app-root host for the OS-drop import flow UI.
 *
 * Mounts `useOsDropDispatch` (Tauri-only side effects), then renders the
 * `ImportConflictModal` and `ImportProgressToast` in response to its state.
 *
 * The post-import file tree refresh is wired inside `FileIndexProvider`,
 * since that provider lives below this overlay in the React tree.
 *
 * @module file-panel/OsDropOverlay
 */

import { useOsDropDispatch } from '../../hooks/useOsDropDispatch.js';
import { ImportConflictModal } from './ImportConflictModal.js';
import { ImportProgressToast } from './ImportProgressToast.js';
import './os-drop.css';

export function OsDropOverlay(): React.JSX.Element {
  const { pending, active, cancel } = useOsDropDispatch();

  return (
    <>
      {pending && (
        <ImportConflictModal
          conflicts={pending.plan.conflicts}
          destRelDir={pending.destRelDir}
          onSubmit={(resolutions) => pending.resolve(resolutions)}
          onCancel={() => pending.resolve(null)}
        />
      )}
      {active && <ImportProgressToast active={active} onCancel={cancel} />}
    </>
  );
}
