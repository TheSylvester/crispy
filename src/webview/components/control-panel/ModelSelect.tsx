/**
 * Model Select — vendor-aware dropdown with optgroups
 *
 * Options: Default (empty) + per-vendor model groups.
 * Value format: "vendor:model" (e.g. "claude:opus").
 * Groups passed as prop from ControlPanel (fetched dynamically).
 *
 * @module control-panel/ModelSelect
 */

import type { ModelOption, VendorModelGroup } from './types.js';

interface ModelSelectProps {
  value: ModelOption;
  onChange: (model: ModelOption) => void;
  groups: VendorModelGroup[];
}

export function ModelSelect({ value, onChange, groups }: ModelSelectProps): React.JSX.Element {
  return (
    <select
      className="crispy-cp-model"
      value={value}
      data-shortcut="Alt+M"
      onChange={(e) => onChange(e.target.value as ModelOption)}
    >
      <option value="">Default</option>
      {groups.map((group) => (
        <optgroup key={group.vendor} label={group.label}>
          {group.models.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
