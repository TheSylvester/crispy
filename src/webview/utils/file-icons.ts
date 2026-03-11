/**
 * File Icons — inline SVG icons for file types and folders
 *
 * Returns React SVG elements colored by file type. No external
 * dependencies or CDN requests — all icons are inline.
 *
 * @module file-icons
 */

import { createElement, type JSX } from 'react';

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

const EXT_COLORS: Record<string, string> = {
  // TypeScript / JavaScript
  '.ts': '#3178c6',
  '.tsx': '#3178c6',
  '.js': '#f1e05a',
  '.jsx': '#f1e05a',
  '.mjs': '#f1e05a',
  '.cjs': '#f1e05a',
  // HTML / CSS
  '.html': '#e34c26',
  '.htm': '#e34c26',
  '.css': '#563d7c',
  '.scss': '#c6538c',
  '.less': '#1d365d',
  // Data / config
  '.json': '#808080',
  '.jsonl': '#808080',
  '.yml': '#808080',
  '.yaml': '#808080',
  '.toml': '#808080',
  '.xml': '#808080',
  '.graphql': '#e535ab',
  '.gql': '#e535ab',
  '.sql': '#e38c00',
  '.env': '#ecd53f',
  // Markdown / docs
  '.md': '#083fa1',
  '.markdown': '#083fa1',
  // Python
  '.py': '#3572A5',
  // Rust
  '.rs': '#dea584',
  // Go
  '.go': '#00ADD8',
  // Java / Kotlin
  '.java': '#b07219',
  '.kt': '#A97BFF',
  // C / C++
  '.c': '#555555',
  '.h': '#555555',
  '.cpp': '#f34b7d',
  '.hpp': '#f34b7d',
  // Shell
  '.sh': '#89e051',
  '.bash': '#89e051',
  '.zsh': '#89e051',
  // Ruby / PHP
  '.rb': '#701516',
  '.php': '#4F5D95',
  // Swift
  '.swift': '#F05138',
  // Lua
  '.lua': '#000080',
  // R
  '.r': '#198CE7',
  // Frontend frameworks
  '.vue': '#41b883',
  '.svelte': '#ff3e00',
  // Image
  '.png': '#a074c4',
  '.jpg': '#a074c4',
  '.jpeg': '#a074c4',
  '.gif': '#a074c4',
  '.ico': '#a074c4',
  '.webp': '#a074c4',
  '.svg': '#ffb13b',
  // Lock
  '.lock': '#808080',
  // Git
  '.gitignore': '#f05032',
};

/** Special full-filename overrides (lowercase) */
const FILENAME_COLORS: Record<string, string> = {
  'dockerfile': '#384d54',
  'makefile': '#427819',
  'license': '#808080',
  'package.json': '#cb3837',
  'tsconfig.json': '#3178c6',
};

const FOLDER_CLOSED_COLOR = '#dcb67a';
const FOLDER_OPEN_COLOR = '#e8a838';
const DEFAULT_FILE_COLOR = '#8a8a8a';

// ---------------------------------------------------------------------------
// SVG icon components (using createElement to avoid JSX transform issues)
// ---------------------------------------------------------------------------

function FileIcon({ color }: { color: string }): JSX.Element {
  return createElement(
    'svg',
    {
      className: 'crispy-file-node__icon',
      width: 16,
      height: 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
    },
    // Page outline
    createElement('path', {
      d: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z',
      fill: '#2d2d2d',
      stroke: '#555',
      strokeWidth: 0.5,
    }),
    // Folded corner
    createElement('path', {
      d: 'M9 1v4h4',
      stroke: '#555',
      strokeWidth: 0.5,
      fill: '#3a3a3a',
    }),
    // Colored type indicator (small circle)
    createElement('circle', {
      cx: 8,
      cy: 10.5,
      r: 3,
      fill: color,
    }),
  );
}

function FolderIcon({ open }: { open: boolean }): JSX.Element {
  const color = open ? FOLDER_OPEN_COLOR : FOLDER_CLOSED_COLOR;

  if (open) {
    return createElement(
      'svg',
      {
        className: 'crispy-file-node__icon',
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
      },
      // Back of folder
      createElement('path', {
        d: 'M1 3a1 1 0 011-1h4l1.5 1.5H14a1 1 0 011 1V5H1V3z',
        fill: color,
        opacity: 0.7,
      }),
      // Open front flap
      createElement('path', {
        d: 'M1 5h14l-2 8H3L1 5z',
        fill: color,
      }),
    );
  }

  return createElement(
    'svg',
    {
      className: 'crispy-file-node__icon',
      width: 16,
      height: 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
    },
    // Closed folder
    createElement('path', {
      d: 'M1 3a1 1 0 011-1h4l1.5 1.5H14a1 1 0 011 1v8a1 1 0 01-1 1H2a1 1 0 01-1-1V3z',
      fill: color,
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns an inline SVG React element for a file or folder.
 *
 * - For directories, pass `expanded` as a boolean (true/false).
 * - For files, omit `expanded` (leave it undefined).
 */
export function getFileIcon(fileName: string, expanded?: boolean): JSX.Element {
  // Directory
  if (expanded !== undefined) {
    return FolderIcon({ open: expanded });
  }

  // File — check full filename first, then extension
  const lower = fileName.toLowerCase();
  const filenameColor = FILENAME_COLORS[lower];
  if (filenameColor) return FileIcon({ color: filenameColor });

  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = lower.slice(dotIdx);
    const color = EXT_COLORS[ext];
    if (color) return FileIcon({ color });
  }

  return FileIcon({ color: DEFAULT_FILE_COLOR });
}
