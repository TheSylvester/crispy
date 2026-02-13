/**
 * Standard Approval — default permission renderer for tool approvals
 *
 * Renders tool info (name, YAML input preview) and action buttons.
 * No textarea — standard approvals (Bash, Edit, Write, etc.) only
 * need buttons. Covers ~95% of real-world approvals.
 *
 * @module approval/StandardApproval
 */

import type { ApprovalOption } from '../../../core/channel-events.js';
import { yamlDump } from './approval-utils.js';

interface StandardApprovalProps {
  toolName: string;
  input: unknown;
  reason?: string;
  options: ApprovalOption[];
  onResolve: (optionId: string) => void;
}

export function StandardApproval({
  toolName,
  input,
  reason,
  options,
  onResolve,
}: StandardApprovalProps): React.JSX.Element {
  return (
    <div className="crispy-approval-standard">
      <h4 className="crispy-approval-header">
        Permission: {toolName}
        {reason && (
          <div className="crispy-approval-header__subtitle">{reason}</div>
        )}
      </h4>

      <div className="crispy-approval-content">
        <pre>{yamlDump(input)}</pre>
      </div>

      <div className="crispy-approval-buttons">
        {options.map((option) => (
          <button
            key={option.id}
            className={`crispy-approval-btn ${
              option.id === 'allow'
                ? 'crispy-approval-btn--primary'
                : 'crispy-approval-btn--secondary'
            }`}
            onClick={() => onResolve(option.id)}
            title={option.description}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
