/**
 * Shared utility functions for tool renderers.
 * Consolidates duplicated helpers from individual tool files.
 *
 * @module webview/renderers/tools/shared/tool-utils
 */

/**
 * Count lines in text and format as "{n} {noun}(s)".
 * Used by most tool renderers for result summaries.
 *
 * @param text - The text to count lines in (null returns '')
 * @param noun - The noun to pluralize (e.g., 'line', 'match', 'file')
 * @param filterEmpty - If true, trim and filter empty lines before counting (used by Grep/Glob)
 */
export function formatCount(text: string | null, noun: string, filterEmpty = false): string {
  if (!text) return '';
  const lines = filterEmpty
    ? text.trim().split('\n').filter(Boolean)
    : text.split('\n');
  const count = lines.length;
  return `${count} ${noun}${count !== 1 ? 's' : ''}`;
}

/**
 * Format line count for content that may be string or ContentBlock[].
 * Used by GenericTool which receives mixed content types.
 */
export function formatLineCount(content: string | unknown[] | null): string {
  if (!content || typeof content !== 'string') return '';
  return formatCount(content, 'line');
}

/**
 * Extract text from tool result content (string or ContentBlock[]).
 * Handles both plain string results and array-of-blocks results.
 */
export function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          'text' in b &&
          typeof (b as Record<string, unknown>).text === 'string',
      )
      .map((b) => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

/**
 * Infer programming language from a file path.
 * Handles extensionless filenames (Dockerfile, Makefile) and standard extensions.
 */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  dockerfile: 'docker',
  makefile: 'makefile',
};

export function inferLanguage(filePath: string): string {
  const basename = filePath.split('/').pop() ?? '';
  const lower = basename.toLowerCase();

  // Handle extensionless filenames like Dockerfile, Makefile
  if (EXT_TO_LANG[lower]) return EXT_TO_LANG[lower];

  const ext = lower.split('.').pop() ?? '';
  return EXT_TO_LANG[ext] ?? 'text';
}
