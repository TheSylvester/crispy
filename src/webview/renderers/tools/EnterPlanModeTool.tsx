/**
 * EnterPlanMode Tool Renderer
 *
 * Minimal card — empty input (SDK defines {}), auto-approved, no body content.
 * Just a visual marker that plan mode was entered.
 *
 * @module webview/renderers/tools/EnterPlanModeTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';

export function EnterPlanModeTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  // Result summary
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Denied' : 'Entered'
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83D\uDCCB'}
      badgeColor="#3b82f6"
      badgeLabel="EnterPlanMode"
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">Planning mode</span>
      }
    />
  );
}
