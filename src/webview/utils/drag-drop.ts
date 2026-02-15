/**
 * Drag-and-Drop Utilities — file path extraction from VS Code drag events
 *
 * Handles 4 different data transfer formats used by VS Code:
 * 1. text/uri-list — File Explorer (file:// URIs)
 * 2. codeeditors — Editor tabs (JSON with resource.path)
 * 3. resourceurls — WSL (vscode-remote:// URIs)
 * 4. text/plain — Fallback (line-separated paths)
 *
 * Ported from Leto's webview-next/components/image-attachments.ts.
 *
 * @module utils/drag-drop
 */

/** Supported image file extensions. */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Check if a file extension is a supported image type.
 *
 * @param ext - File extension (with or without leading dot)
 * @returns True if the extension is a supported image type
 */
export function isImageExtension(ext: string): boolean {
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return IMAGE_EXTENSIONS.has(normalizedExt);
}

/**
 * Extract file paths from a native DragEvent.
 *
 * Must be called synchronously within the drop handler — `getData()` returns
 * empty strings if called after the event is released (React pools synthetic
 * events, so pass `e.nativeEvent` from React handlers).
 *
 * Handles 4 VS Code drag data formats in priority order:
 * 1. `text/uri-list` — File Explorer `file://` URIs
 * 2. `codeeditors` — Editor tab JSON with `resource.path`
 * 3. `resourceurls` — WSL `vscode-remote://` URIs
 * 4. `text/plain` — Fallback (absolute paths, `file://` URIs)
 *
 * @param e - The native DragEvent (not React SyntheticEvent)
 * @returns Array of file paths (empty if none found)
 */
export function extractFilePathsFromDragEvent(e: DragEvent): string[] {
  const filePaths: string[] = [];

  // 1. text/uri-list — File Explorer uses this with file:// URIs
  const uriList = e.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    const uris = uriList.split('\n').filter((uri) => uri.trim() && !uri.startsWith('#'));
    for (const uri of uris) {
      const trimmed = uri.trim();
      if (trimmed.startsWith('file://')) {
        // file:// → path conversion produces /C:/... on Windows, which is
        // valid for Node's fs APIs. No further normalization needed.
        filePaths.push(decodeURIComponent(trimmed.slice(7)));
      }
    }
  }

  // 2. codeeditors — Editor tabs provide JSON with resource.path
  if (filePaths.length === 0) {
    const codeEditors = e.dataTransfer?.getData('codeeditors');
    if (codeEditors) {
      try {
        const editors = JSON.parse(codeEditors);
        for (const editor of editors) {
          if (editor.resource?.path) {
            filePaths.push(editor.resource.path);
          }
        }
      } catch {
        /* Ignore parse errors */
      }
    }
  }

  // 3. resourceurls — vscode-remote:// URIs (WSL)
  if (filePaths.length === 0) {
    const resourceUrls = e.dataTransfer?.getData('resourceurls');
    if (resourceUrls) {
      try {
        const urls = JSON.parse(resourceUrls);
        for (const url of urls) {
          const match = url.match(/vscode-remote:\/\/[^/]+(.+)/);
          if (match) {
            filePaths.push(decodeURIComponent(match[1]));
          }
        }
      } catch {
        /* Ignore parse errors */
      }
    }
  }

  // 4. text/plain fallback — line-separated absolute paths or file:// URIs
  if (filePaths.length === 0) {
    const plainText = e.dataTransfer?.getData('text/plain');
    if (plainText) {
      const lines = plainText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('/')) {
          filePaths.push(line);
        } else if (line.startsWith('file://')) {
          filePaths.push(decodeURIComponent(line.slice(7)));
        }
      }
    }
  }

  return filePaths;
}
