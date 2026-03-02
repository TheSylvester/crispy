/**
 * FilterBar — layout wrapper for session list filters
 *
 * Contains the project selector <select>, vendor filter chips, and search
 * input in a vertical stack. The project selector was moved here from
 * TitleBar to keep all filtering controls co-located with the session list.
 *
 * Thin layout wrapper — filtering logic lives in the parent SessionSelector.
 *
 * @module FilterBar
 */

import type { KeyboardEvent, ChangeEvent, RefObject } from 'react';
import type { AvailableCwd } from '../../hooks/useAvailableCwds.js';
import { VendorChips } from './VendorChips.js';

export type ViewMode = 'sessions' | 'activity';

interface FilterBarProps {
  /** Available project CWDs for the project selector. */
  availableCwds: AvailableCwd[];
  /** Currently selected project slug, or null for "All Projects". */
  selectedCwd: string | null;
  /** Callback when the project selection changes. */
  onCwdChange: (slug: string | null) => void;
  /** Available vendor slugs for the chip bar. */
  availableVendors: string[];
  /** Currently active vendor filters. */
  activeVendors: Set<string>;
  /** Callback when a vendor chip is toggled. */
  onVendorToggle: (vendor: string) => void;
  /** Current search query string. */
  searchQuery: string;
  /** Callback when the search input changes. */
  onSearchChange: (query: string) => void;
  /** Keyboard handler for the search input (arrow nav, etc.). */
  onSearchKeyDown: (e: KeyboardEvent) => void;
  /** Ref forwarded to the search input for focus management. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Current view mode — sessions list or activity path. */
  viewMode?: ViewMode;
  /** Callback when view mode is toggled. */
  onViewModeChange?: (mode: ViewMode) => void;
}

export function FilterBar({
  availableCwds,
  selectedCwd,
  onCwdChange,
  availableVendors,
  activeVendors,
  onVendorToggle,
  searchQuery,
  onSearchChange,
  onSearchKeyDown,
  searchInputRef,
  viewMode = 'sessions',
  onViewModeChange,
}: FilterBarProps): React.JSX.Element {
  const handleCwdChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onCwdChange(e.target.value || null);
  };

  return (
    <div className="crispy-filter-bar">
      {availableCwds.length > 0 && (
        <select
          className="crispy-filter-bar__cwd"
          value={selectedCwd ?? ''}
          onChange={handleCwdChange}
          title="Filter by project"
        >
          <option value="">All Projects</option>
          {availableCwds.map(cwd => (
            <option key={cwd.slug} value={cwd.slug} title={cwd.fullPath}>
              {cwd.display}
            </option>
          ))}
        </select>
      )}
      <div className="crispy-filter-bar__tabs">
        {onViewModeChange && (
          <button
            className={`crispy-filter-bar__tab${viewMode === 'activity' ? ' crispy-filter-bar__tab--active' : ''}`}
            onClick={() => onViewModeChange('activity')}
            title="Activity Path"
          >
            ⚡ Activity
          </button>
        )}
        {onViewModeChange && (
          <button
            className={`crispy-filter-bar__tab${viewMode === 'sessions' ? ' crispy-filter-bar__tab--active' : ''}`}
            onClick={() => onViewModeChange('sessions')}
            title="Sessions List"
          >
            ☰ Sessions
          </button>
        )}
        <div className="crispy-filter-bar__tab-spacer" />
        <VendorChips
          availableVendors={availableVendors}
          activeVendors={activeVendors}
          onToggle={onVendorToggle}
        />
      </div>
      {viewMode === 'sessions' && (
        <input
          ref={searchInputRef}
          className="crispy-filter-bar__search"
          type="text"
          placeholder="Search conversations…"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      )}
    </div>
  );
}
