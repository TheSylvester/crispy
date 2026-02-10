/**
 * Write Tool Renderer
 *
 * Shows file path + line count in header, code preview in body.
 *
 * @module webview/renderers/tools/WriteTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { FilePath } from './shared/FilePath.js';
import { CodePreview } from './shared/CodePreview.js';
import { isFileWriteInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

export function WriteTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isFileWriteInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { file_path: string; content: string })
    : null;

  const filePath = input?.file_path ?? '(unknown)';
  const content = input?.content ?? '';
  const lineCount = content.split('\n').length;
  const lang = guessLanguage(filePath);

  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : 'Written'
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\u270E'}
      badgeColor="#10b981"
      badgeLabel="Write"
      defaultOpen={true}
      resultSummary={resultSummary}
      headerContent={
        <>
          <FilePath path={filePath} />
          <span className="crispy-tool-line-info">({lineCount} lines)</span>
        </>
      }
    >
      {content && <CodePreview code={content} language={lang} />}

      {entry.result && entry.result.is_error && (
        <div className="crispy-tool-result">
          <pre className="crispy-tool-result__text crispy-tool-result__text--error">
            {typeof entry.result.content === 'string' ? entry.result.content : JSON.stringify(entry.result.content, null, 2)}
          </pre>
        </div>
      )}
    </ToolCardShell>
  );
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    css: 'css', html: 'html', json: 'json', md: 'markdown',
    sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
    toml: 'toml', sql: 'sql', c: 'c', cpp: 'cpp', h: 'c',
  };
  return map[ext] ?? 'text';
}
