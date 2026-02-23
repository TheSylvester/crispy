/**
 * TitleBar — Fixed header with CWD selector
 *
 * Slim single-row bar. Session dropdown and +New button now live in the
 * transcript tab header (see FlexAppLayout). Files/Tools toggles removed
 * in favour of FlexLayout border tabs.
 *
 * The connection indicator dot has moved to TranscriptHeader (per-tab) so
 * each tab shows its own session's channel state independently.
 *
 * @module TitleBar
 */

import { useCallback, useMemo } from 'react';
import { useSession } from '../context/SessionContext.js';
import { useCwd } from '../hooks/useSessionCwd.js';
import { useAvailableCwds } from '../hooks/useAvailableCwds.js';

export function TitleBar(): React.JSX.Element {
  const { selectedCwd, setSelectedCwd } = useSession();
  const { fullPath } = useCwd();
  const allCwds = useAvailableCwds();

  /** Cap visible CWDs to keep the native dropdown manageable.
   *  Always includes the currently selected CWD even if it falls outside the cap. */
  const MAX_CWDS = 15;
  const availableCwds = useMemo(() => {
    if (allCwds.length <= MAX_CWDS) return allCwds;
    const top = allCwds.slice(0, MAX_CWDS);
    if (selectedCwd && !top.some((c) => c.slug === selectedCwd)) {
      const selected = allCwds.find((c) => c.slug === selectedCwd);
      if (selected) top.push(selected);
    }
    return top;
  }, [allCwds, selectedCwd]);

  const handleCwdChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedCwd(e.target.value || null);
  }, [setSelectedCwd]);

  return (
    <header className="crispy-titlebar">
      <div className="crispy-titlebar__center">
        {availableCwds.length > 0 && (
          <select
            className="crispy-titlebar__cwd-select"
            value={selectedCwd ?? ''}
            onChange={handleCwdChange}
            title={fullPath ?? 'All projects'}
          >
            <option value="">All Projects</option>
            {availableCwds.map((cwd) => (
              <option key={cwd.slug} value={cwd.slug} title={cwd.fullPath}>
                {cwd.display}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}
