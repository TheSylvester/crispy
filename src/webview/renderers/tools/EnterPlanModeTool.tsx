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
import { getToolMeta } from './shared/tool-metadata.js';

const meta = getToolMeta('EnterPlanMode');

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
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="EnterPlanMode"
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">Planning mode</span>
      }
    />
  );
}
