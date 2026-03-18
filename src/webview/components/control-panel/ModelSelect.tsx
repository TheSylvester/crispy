/**
 * Model Select — vendor-aware dropdown with optgroups
 *
 * Options: per-vendor model groups (Claude includes Default as first entry).
 * Value format: "vendor:model" (e.g. "claude:opus").
 * Groups passed as prop from ControlPanel (fetched dynamically).
 *
 * @module control-panel/ModelSelect
 */

import { useMemo } from 'react';
import type { ModelOption, VendorModelGroup } from './types.js';

interface ModelSelectProps {
  value: ModelOption;
  onChange: (model: ModelOption) => void;
  groups: VendorModelGroup[];
}

export function ModelSelect({ value, onChange, groups }: ModelSelectProps): React.JSX.Element {
  // If the current value isn't in any group, inject it so the <select> stays
  // on the right option instead of falling back to the first entry.
  const enrichedGroups = useEnrichedGroups(groups, value);

  return (
    <select
      className="crispy-cp-model"
      value={value}
      data-shortcut="Alt+M"
      onChange={(e) => onChange(e.target.value as ModelOption)}
    >
      {enrichedGroups.map((group) => (
        <optgroup
          key={group.vendor}
          label={group.available === false ? `${group.label} (not installed)` : group.label}
        >
          {group.models.map((m) => (
            <option key={m.value} value={m.value} disabled={group.available === false}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * If `value` doesn't match any option in `groups`, inject it into the
 * matching vendor group (or a fallback group) so the `<select>` renders
 * the correct selection instead of silently falling back to the first option.
 */
function useEnrichedGroups(groups: VendorModelGroup[], value: ModelOption): VendorModelGroup[] {
  return useMemo(() => {
    if (!value) return groups;

    // Check if value already exists in the groups
    for (const g of groups) {
      for (const m of g.models) {
        if (m.value === value) return groups;
      }
    }

    // Value is missing — parse vendor:model and inject
    const colonIdx = value.indexOf(':');
    const vendor = colonIdx >= 0 ? value.slice(0, colonIdx) : '';
    const model = colonIdx >= 0 ? value.slice(colonIdx + 1) : value;
    const label = model || 'Unknown';

    return groups.map((g) =>
      g.vendor === vendor
        ? { ...g, models: [...g.models, { value, label }] }
        : g,
    );
  }, [groups, value]);
}
