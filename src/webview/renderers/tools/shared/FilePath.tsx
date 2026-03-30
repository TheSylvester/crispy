/**
 * File Path — monospace file path display with optional line range
 *
 * When a file index and CWD are available, wraps the path in a clickable
 * FileLink. Falls back to a plain <span> when no index is available.
 *
 * @module webview/renderers/tools/shared/FilePath
 */

import { useMemo } from 'react';
import { useFileIndex } from '../../../context/FileIndexContext.js';
import { useCwd } from '../../../hooks/useSessionCwd.js';
import { FileLink } from '../../../components/FileLink.js';
import { normalizePath } from '../../../../core/url-path-resolver.js';

interface FilePathProps {
  path: string;
  lineRange?: string;
}

/**
 * Parse a line number from a lineRange string like ":42" or ":10-20".
 * Returns the first (or only) line number, or undefined.
 */
function parseLineFromRange(lineRange: string | undefined): number | undefined {
  if (!lineRange) return undefined;
  const match = /(\d+)/.exec(lineRange);
  return match ? parseInt(match[1], 10) : undefined;
}

export function FilePath({ path, lineRange }: FilePathProps): React.JSX.Element {
  const index = useFileIndex();
  const { fullPath: cwd } = useCwd();

  // Strip CWD prefix to make absolute paths relative for index matching
  const relativePath = useMemo(() => {
    if (!cwd) return path;
    const nPath = normalizePath(path);
    const nCwd = normalizePath(cwd);
    if (!nPath.startsWith(nCwd)) return path;
    const stripped = nPath.slice(nCwd.length);
    return stripped.startsWith('/') ? stripped.slice(1) : stripped;
  }, [path, cwd]);

  const matches = useMemo(() => {
    if (!index) return [];
    return index.match(relativePath);
  }, [index, relativePath]);

  // Show parent/filename for compact display, full relative path in tooltip.
  // e.g. "src/webview/components/TranscriptViewer.tsx" → "components/TranscriptViewer.tsx"
  const shortPath = useMemo(() => {
    const parts = relativePath.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : relativePath;
  }, [relativePath]);

  const line = parseLineFromRange(lineRange);
  const content = (
    <span className="u-mono-pill crispy-tool-filepath" title={relativePath + (lineRange ?? '')}>
      {shortPath}
      {lineRange && <span style={{ opacity: 0.6 }}>{lineRange}</span>}
    </span>
  );

  // If we have an index and the path is resolvable, make it clickable
  // Accept both Unix absolute (/...) and Windows absolute (C:\... or c:/...)
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
  if (index && (matches.length > 0 || isAbsolute)) {
    return (
      <FileLink
        token={matches.length > 0 ? matches[0].absolutePath : path}
        matches={matches}
        line={line}
      >
        {content}
      </FileLink>
    );
  }

  return content;
}
