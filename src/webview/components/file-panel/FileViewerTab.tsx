/**
 * FileViewerTab — standalone file viewer rendered as a FlexLayout tab
 *
 * Reads the file via transport.readFile() on mount. Renders FileViewer
 * (the existing content renderer) with toolbar controls. Unlike
 * FileViewerPanel, this has no sidebar positioning, resize handle, or
 * annotation popover — FlexLayout handles sizing and tab lifecycle.
 *
 * @module file-panel/FileViewerTab
 */

import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { inferLanguage } from '../../renderers/tools/shared/tool-utils.js';
import { FileViewer } from './FileViewer.js';
import type { ActiveFileView } from '../../context/FilePanelContext.js';

interface FileViewerTabProps {
  path: string;
  line?: number;
}

/** Whether the file looks like a prompt/instruction file that can be executed */
function isExecutable(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

export function FileViewerTab({ path, line }: FileViewerTabProps): React.JSX.Element {
  const transport = useTransport();
  const envKind = useEnvironment();
  const [file, setFile] = useState<ActiveFileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(false);

  // Load file on mount or when path changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    transport.readFile(path).then(({ content, size }) => {
      if (cancelled) return;
      const relativePath = path.split('/').pop() ?? path;
      const fileView: ActiveFileView = {
        path,
        relativePath,
        content,
        language: inferLanguage(relativePath),
        size,
        line,
      };
      setFile(fileView);
      setMarkdownPreview(/\.(md|markdown)$/i.test(relativePath));
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [path, transport]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update line when config changes (e.g. clicking same file at different line)
  useEffect(() => {
    if (file && line !== file.line) {
      setFile(prev => prev ? { ...prev, line } : prev);
    }
  }, [line]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExecute = useCallback(() => {
    if (!file) return;
    if (envKind === 'websocket') {
      const key = `crispy-execute-${crypto.randomUUID()}`;
      sessionStorage.setItem(key, file.content);
      const url = new URL(window.location.pathname, window.location.origin);
      url.searchParams.set('execute', key);
      window.open(url.toString(), '_blank');
    } else {
      window.postMessage({ kind: 'executeInCrispy', content: file.content }, '*');
    }
  }, [file, envKind]);

  const handleInsertIntoChat = useCallback(() => {
    if (!file) return;
    const annotation = `From \`${file.relativePath}\`:\n\`\`\`\`${file.language}\n${file.content}\n\`\`\`\`\n`;
    window.postMessage({ kind: 'insertIntoChat', text: annotation }, '*');
  }, [file]);

  const isMarkdownFile = file ? /\.(md|markdown)$/i.test(file.relativePath) : false;
  const showExecute = file && isExecutable(file.relativePath);

  return (
    <div className="crispy-file-viewer-tab">
      <div className="crispy-file-viewer-tab__toolbar">
        <span className="crispy-file-viewer-tab__path" title={path}>
          {file?.relativePath ?? (loading ? 'Loading...' : 'Error')}
        </span>
        <div className="crispy-file-viewer-tab__actions">
          {file && (
            <>
              <button
                className={`crispy-file-viewer-tab__btn${wordWrap ? ' crispy-file-viewer-tab__btn--active' : ''}`}
                onClick={() => setWordWrap(w => !w)}
                title="Toggle word wrap"
              >
                Wrap
              </button>
              {isMarkdownFile && (
                <button
                  className={`crispy-file-viewer-tab__btn${markdownPreview ? ' crispy-file-viewer-tab__btn--active' : ''}`}
                  onClick={() => setMarkdownPreview(p => !p)}
                  title="Toggle markdown preview"
                >
                  Preview
                </button>
              )}
              <button
                className="crispy-file-viewer-tab__btn"
                onClick={handleInsertIntoChat}
                title="Insert file content into chat"
              >
                Insert
              </button>
            </>
          )}
          {showExecute && (
            <button
              className="crispy-file-viewer-tab__btn crispy-file-viewer-tab__btn--execute"
              onClick={handleExecute}
              title="Open a new session with this file's content as the prompt"
            >
              Execute
            </button>
          )}
        </div>
      </div>
      <div className="crispy-file-viewer-tab__body">
        {file ? (
          <FileViewer file={file} error={error} loading={loading} wordWrap={wordWrap} markdownPreview={markdownPreview} />
        ) : loading ? (
          <div className="crispy-file-viewer">
            <div className="crispy-file-viewer__loading">Loading...</div>
          </div>
        ) : error ? (
          <div className="crispy-file-viewer">
            <div className="crispy-file-viewer__error">{error}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
