/**
 * FileLink — clickable file reference component
 *
 * Behavior varies by environment:
 * - VS Code: opens file via transport RPC. Multiple matches → native QuickPick.
 * - Browser: renders vscode:// URI link. Multiple matches → opens first with warning.
 *
 * Structural matches with no index hits validate via fileExists() on click.
 *
 * @module FileLink
 */

import { useCallback } from 'react';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { useTransport } from '../context/TransportContext.js';
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
  const env = useEnvironment();
  const transport = useTransport();

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (env === 'vscode') {
      let targetPath: string | null = null;

      if (matches.length === 1) {
        targetPath = matches[0].absolutePath;
      } else if (matches.length > 1) {
        // Multiple matches → VS Code QuickPick
        const candidates = matches.map((m) => m.relativePath);
        const result = await transport.pickFile(candidates);
        if (result.picked) {
          // Find the full match by relative path
          const picked = matches.find((m) => m.relativePath === result.picked);
          targetPath = picked?.absolutePath ?? null;
        }
      } else {
        // No index matches — structural path, validate on click
        const exists = await transport.fileExists(token);
        if (exists) {
          targetPath = token;
        }
      }

      if (targetPath) {
        transport.openFile(targetPath, line, col).catch((err) => {
          console.warn('[crispy] Failed to open file:', err);
        });
      }
    }
    // Browser clicks are handled by the <a> href below
  }, [env, transport, matches, token, line, col]);

  const display = children ?? token;

  if (env === 'websocket') {
    // Browser: use vscode:// URI protocol for direct opening
    const targetPath = matches.length > 0 ? matches[0].absolutePath : token;
    const uri = `vscode://file${targetPath}${line ? `:${line}` : ''}${line && col ? `:${col}` : ''}`;

    if (matches.length > 1) {
      console.warn(
        `[crispy] Multiple matches for "${token}": ${matches.map((m) => m.relativePath).join(', ')}. Opening first.`,
      );
    }

    return (
      <a
        className="crispy-file-link"
        href={uri}
        title={targetPath}
        onClick={(e) => e.stopPropagation()}
      >
        {display}
      </a>
    );
  }

  // VS Code: click handler opens via transport RPC
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
