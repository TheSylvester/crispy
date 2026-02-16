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
import { isSkillInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

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
    ? entry.result.is_error ? 'Failed' : formatLineCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\u2728'}
      badgeColor="#7c3aed"
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

/** Extract display text from tool_result content (string or array of text blocks). */
function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string')
      .map((b) => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

function formatLineCount(text: string | null): string {
  if (!text) return '';
  const lines = text.split('\n').length;
  return `${lines} line${lines !== 1 ? 's' : ''}`;
}
