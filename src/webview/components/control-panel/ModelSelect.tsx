/**
 * Model Select — simple dropdown for model selection
 *
 * Options: Default (empty), Opus, Sonnet, Haiku.
 *
 * @module control-panel/ModelSelect
 */

import type { ModelOption } from './types.js';

interface ModelSelectProps {
  value: ModelOption;
  onChange: (model: ModelOption) => void;
}

const OPTIONS: { value: ModelOption; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

export function ModelSelect({ value, onChange }: ModelSelectProps): React.JSX.Element {
  return (
    <select
      className="crispy-cp-model"
      value={value}
      data-shortcut="Alt+M"
      onChange={(e) => onChange(e.target.value as ModelOption)}
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
