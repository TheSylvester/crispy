/**
 * FileViewer — code preview for the active file in the right panel
 *
 * Renders file content in a scrollable pre/code block with the inferred
 * language for syntax-class hinting. Shows error states (binary, too large,
 * not found) when the read fails.
 *
 * @module file-panel/FileViewer
 */

import type { ActiveFileView } from '../../context/FilePanelContext.js';
import { CodePreview, type LineRange } from '../../renderers/tools/shared/CodePreview.js';

interface FileViewerProps {
  file: ActiveFileView;
  error?: string | null;
  loading?: boolean;
  /** Enable line selection for annotation */
  selectable?: boolean;
  selectedLines?: LineRange | null;
  onLineSelect?: (range: LineRange | null) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewer({ file, error, loading, selectable, selectedLines, onLineSelect }: FileViewerProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="crispy-file-viewer">
        <div className="crispy-file-viewer__loading">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="crispy-file-viewer">
        <div className="crispy-file-viewer__error">
          <ErrorMessage error={error} />
        </div>
      </div>
    );
  }

  return (
    <div className="crispy-file-viewer">
      <div className="crispy-file-viewer__info">
        <span className="crispy-file-viewer__lang">{file.language}</span>
        <span className="crispy-file-viewer__size">{formatSize(file.size)}</span>
      </div>
      <CodePreview
        code={file.content}
        language={file.language}
        maxHeight={99999}
        selectable={selectable}
        selectedLines={selectedLines}
        onLineSelect={onLineSelect}
      />
    </div>
  );
}

function ErrorMessage({ error }: { error: string }): React.JSX.Element {
  if (error.startsWith('Binary file type:')) {
    const ext = error.replace('Binary file type: ', '');
    return <span>Cannot preview binary file ({ext}). Use the terminal to view.</span>;
  }
  if (error.startsWith('File too large:')) {
    return <span>{error.replace(/max \d+/, (m) => `max ${formatSize(parseInt(m.replace('max ', '')))}`)}</span>;
  }
  if (error.includes('ENOENT') || error.includes('no such file')) {
    return <span>File not found. It may have been deleted.</span>;
  }
  if (error.includes('EACCES') || error.includes('permission denied')) {
    return <span>Cannot read file: permission denied.</span>;
  }
  return <span>{error}</span>;
}
