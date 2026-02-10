/**
 * File Context Toggle — checkbox with filename label
 *
 * Shows the current file context state and label. Checkbox accent-color
 * uses --frame-highlight. Label shows filename or "No file open".
 *
 * @module control-panel/FileContextToggle
 */

import { useId } from 'react';

interface FileContextToggleProps {
  checked: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
}

export function FileContextToggle({ checked, label, onChange }: FileContextToggleProps): React.JSX.Element {
  const inputId = useId();

  return (
    <label className="crispy-cp-file-context" title="Include current file as context" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="crispy-cp-file-context__label">{label}</span>
    </label>
  );
}
