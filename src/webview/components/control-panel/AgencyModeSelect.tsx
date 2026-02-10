/**
 * Agency Mode Select — styled dropdown for permission mode
 *
 * Four modes: plan-mode, edit-automatically, ask-before-edits, bypass-permissions.
 * The bypass-permissions option is hidden unless bypass is enabled.
 * Text and border color inherit from --frame-highlight CSS variable.
 *
 * @module control-panel/AgencyModeSelect
 */

import type { AgencyMode } from './types.js';
import { AGENCY_MODE_LABELS } from './types.js';

interface AgencyModeSelectProps {
  value: AgencyMode;
  showBypassOption: boolean;
  onChange: (mode: AgencyMode) => void;
}

const MODES: AgencyMode[] = [
  'plan-mode',
  'edit-automatically',
  'ask-before-edits',
  'bypass-permissions',
];

export function AgencyModeSelect({ value, showBypassOption, onChange }: AgencyModeSelectProps): React.JSX.Element {
  return (
    <select
      className="crispy-cp-agency"
      value={value}
      data-shortcut="Alt+Q"
      onChange={(e) => onChange(e.target.value as AgencyMode)}
    >
      {MODES.map((mode) => (
        <option
          key={mode}
          value={mode}
          hidden={mode === 'bypass-permissions' && !showBypassOption}
        >
          {AGENCY_MODE_LABELS[mode]}
        </option>
      ))}
    </select>
  );
}
