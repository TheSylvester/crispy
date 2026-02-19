/**
 * Skill Tool Renderer
 *
 * Shows skill name in a badge (like Task shows agent type) with optional
 * args as header description. Renders the result as markdown.
 *
 * @module webview/renderers/tools/SkillTool
 */

import { CrispyMarkdown } from '../CrispyMarkdown.js';
import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount, extractResultText } from './shared/tool-utils.js';
import { isSkillInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('Skill');

export function SkillTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isSkillInput(entry.input as ToolInput)
    ? (entry.input as { skill: string; args?: string })
    : null;

  const skillName = input?.skill ?? 'skill';
  const args = input?.args ?? null;

  const resultText = extractResultText(entry.result?.content);
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel={skillName}
      defaultOpen={true}
      resultSummary={resultSummary}
      headerContent={
        args ? <span className="crispy-tool-description">{args}</span> : undefined
      }
    >
      {/* Result output — rich markdown rendering */}
      {entry.result && resultText && (
        <div className={`prose assistant-text crispy-task-result ${entry.result.is_error ? 'crispy-task-result--error' : ''}`}>
          <CrispyMarkdown>{resultText}</CrispyMarkdown>
        </div>
      )}
    </ToolCardShell>
  );
}
