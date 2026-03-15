/**
 * Agency Mode Select — styled dropdown for permission mode
 *
 * Four modes: plan-mode, edit-automatically, ask-before-edits, bypass-permissions.
 * The bypass-permissions option is hidden unless bypass is enabled.
 * Text and border color inherit from --frame-highlight CSS variable.
 * Compact mode shows shorter labels ("? ask" instead of "? ask before edits").
 *
 * @module control-panel/AgencyModeSelect
 */

import type { AgencyMode } from './types.js';
import { AGENCY_MODE_LABELS, AGENCY_MODE_LABELS_SHORT, AGENCY_MODE_COLORS } from './types.js';

interface AgencyModeSelectProps {
  value: AgencyMode;
  showBypassOption: boolean;
  onChange: (mode: AgencyMode) => void;
  /** Use short labels for narrow layouts. */
  compact?: boolean;
  /** Set --frame-highlight inline to reflect the selected mode's own color. */
  selfColored?: boolean;
}

const MODES: AgencyMode[] = [
  'plan-mode',
  'edit-automatically',
  'ask-before-edits',
  'bypass-permissions',
];

export function AgencyModeSelect({ value, showBypassOption, onChange, compact, selfColored }: AgencyModeSelectProps): React.JSX.Element {
  const labels = compact ? AGENCY_MODE_LABELS_SHORT : AGENCY_MODE_LABELS;
  return (
    <select
      className="crispy-cp-agency"
      value={value}
      onChange={(e) => onChange(e.target.value as AgencyMode)}
      style={selfColored ? { '--frame-highlight': AGENCY_MODE_COLORS[value] } as React.CSSProperties : undefined}
    >
      {MODES.map((mode) => (
        <option
          key={mode}
          value={mode}
          hidden={mode === 'bypass-permissions' && !showBypassOption}
        >
          {labels[mode]}
        </option>
      ))}
    </select>
  );
}
