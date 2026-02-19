/**
 * ExitPlanMode Tool Renderer
 *
 * Shows plan body (collapsed by default) and permissions list.
 * The approval modal (ExitPlanApproval.tsx) shows the plan expanded;
 * this renderer is for the post-resolution transcript view.
 *
 * @module webview/renderers/tools/ExitPlanModeTool
 */

import { CrispyMarkdown } from '../CrispyMarkdown.js';
import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { isExitPlanModeInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('ExitPlanMode');

interface ExitPlanInput {
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  plan?: string;
  pushToRemote?: boolean;
}

export function ExitPlanModeTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isExitPlanModeInput(entry.input as ToolInput)
    ? (entry.input as ExitPlanInput)
    : null;

  const plan = input?.plan ?? null;
  const allowedPrompts = input?.allowedPrompts ?? null;

  // Result summary
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Rejected' : 'Approved'
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="ExitPlanMode"
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">Plan Ready</span>
      }
    >
      {plan && (
        <details className="crispy-plan-details">
          <summary className="crispy-plan-summary">View plan</summary>
          <div className="prose assistant-text crispy-task-result">
            <CrispyMarkdown>{plan}</CrispyMarkdown>
          </div>
        </details>
      )}
      {allowedPrompts && allowedPrompts.length > 0 && (
        <div className="crispy-plan-permissions">
          <div className="crispy-plan-permissions__title">Requested permissions:</div>
          <ul className="crispy-plan-permissions-list">
            {allowedPrompts.map((p, i) => (
              <li key={i}>
                <code className="u-mono-pill crispy-plan-permission__tool">{p.tool}</code>
                <span className="crispy-plan-permission__prompt"> — {p.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ToolCardShell>
  );
}
