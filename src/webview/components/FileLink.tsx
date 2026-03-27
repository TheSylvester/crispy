/**
 * FileLink — clickable file reference component
 *
 * In VS Code: opens files in the native editor via transport.openFile().
 * In browser: opens files in the file viewer panel via FilePanelContext.
 *
 * Structural matches with no index hits validate via fileExists() on click.
 *
 * @module FileLink
 */

import { useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { useFilePanel } from '../context/FilePanelContext.js';
import type { FileMatch } from '../utils/file-index.js';

interface FileLinkProps {
  /** The raw token from the text (used for display fallback) */
  token: string;
  /** Resolved file matches from the index */
  matches: FileMatch[];
  /** Line number (1-based) */
  line?: number;
  /** Column number (1-based) */
  col?: number;
  /** Rendered content (defaults to token) */
  children?: React.ReactNode;
}

export function FileLink({ token, matches, line, col, children }: FileLinkProps): React.JSX.Element {
  const transport = useTransport();
  const environment = useEnvironment();
  const { openFileAbsolute } = useFilePanel();
  const isVSCode = environment === 'vscode';

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    let targetPath: string | null = null;

    if (matches.length === 1) {
      targetPath = matches[0].absolutePath;
    } else if (matches.length > 1) {
      // Multiple matches — open first, log warning. Future: picker UI.
      console.warn(
        `[crispy] Multiple matches for "${token}": ${matches.map((m) => m.relativePath).join(', ')}. Opening first.`,
      );
      targetPath = matches[0].absolutePath;
    } else {
      // No index matches — structural path, validate on click
      const exists = await transport.fileExists(token);
      if (exists) targetPath = token;
    }

    if (targetPath) {
      if (isVSCode) {
        transport.openFile(targetPath, line, col);
      } else {
        openFileAbsolute(targetPath, line);
      }
    }
  }, [matches, token, line, col, transport, openFileAbsolute, isVSCode]);

  const display = children ?? token;

  return (
    <a
      className="crispy-file-link"
      href="#"
      title={matches.length > 0 ? matches[0].absolutePath : token}
      onClick={handleClick}
    >
      {display}
    </a>
  );
}
