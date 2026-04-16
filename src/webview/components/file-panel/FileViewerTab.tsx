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

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { inferLanguage } from '../../renderers/tools/shared/tool-utils.js';
import { useTabControllerOptional } from '../../context/TabControllerContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { isImageExtension } from '../../utils/drag-drop.js';
import { FileViewer } from './FileViewer.js';
import { TranscriptAnnotationPopover } from '../TranscriptAnnotationPopover.js';
import type { TranscriptAnnotationState } from '../../hooks/useTranscriptAnnotation.js';
import type { ActiveFileView } from '../../context/FilePanelContext.js';

interface FileViewerTabProps {
  path: string;
  relativePath?: string;
  line?: number;
}

/** Whether the file looks like a prompt/instruction file that can be executed */
function isExecutable(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

/** Walk up from a node to find the nearest ancestor with data-line-number */
function getLineNumber(node: Node): number | null {
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current && current instanceof Element) {
    const ln = current.getAttribute('data-line-number');
    if (ln) return parseInt(ln, 10);
    current = current.parentElement;
  }
  return null;
}

/**
 * Lightweight text-selection hook for file viewer — detects selections within
 * the body container and provides TranscriptAnnotationState for the popover.
 * On submit, inserts the quoted text into chat via postMessage.
 */
function useFileViewerSelection(
  bodyRef: React.RefObject<HTMLDivElement | null>,
  file: ActiveFileView | null,
): TranscriptAnnotationState {
  const [selection, setSelection] = useState<TranscriptAnnotationState['selection']>(null);
  const [lineRange, setLineRange] = useState<{ start: number; end: number } | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const annotationModeRef = useRef(false);
  annotationModeRef.current = annotationMode;

  const clearAll = useCallback(() => {
    setSelection(null);
    setLineRange(null);
    setAnnotationMode(false);
    setAnnotationText('');
  }, []);

  const enterAnnotationMode = useCallback(() => {
    if (selection) window.getSelection()?.removeAllRanges();
    setAnnotationMode(true);
  }, [selection]);

  const submitAnnotation = useCallback(() => {
    if (!selection) return;
    const label = file?.relativePath ?? 'selection';
    const lineLabel = lineRange
      ? lineRange.start === lineRange.end
        ? `:${lineRange.start}`
        : `:${lineRange.start}-${lineRange.end}`
      : '';
    let text = `From \`${label}${lineLabel}\`:\n\`\`\`\`\n${selection.text}\n\`\`\`\`\n`;
    if (annotationText.trim()) {
      text += annotationText.trim().split('\n').map(l => `* ${l}`).join('\n') + '\n';
    }
    window.postMessage({ kind: 'insertIntoChat', text }, '*');
    clearAll();
  }, [selection, annotationText, file, lineRange, clearAll]);

  // Mouseup — detect selections within the body container
  useEffect(() => {
    const handleMouseUp = () => {
      requestAnimationFrame(() => {
        if (annotationModeRef.current) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const rawText = sel.toString();
        const text = rawText.trim();
        if (!text) return;
        const container = bodyRef.current;
        if (!container || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
        const startLine = getLineNumber(range.startContainer);
        let endLine = getLineNumber(range.endContainer);
        // When triple-click or drag extends into the next line's trailing newline,
        // clamp to the previous line to avoid off-by-one
        if (endLine && startLine && endLine > startLine && rawText.endsWith('\n')) {
          endLine = endLine - 1;
        }
        setLineRange(startLine && endLine ? { start: startLine, end: endLine } : null);
        setSelection({
          text,
          rect: range.getBoundingClientRect(),
          range: range.cloneRange(),
          isCodeBlock: true,
          entryUuid: 'file-viewer',
        });
      });
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [bodyRef]);

  // Scroll dismisses popover (unless in annotation mode)
  useEffect(() => {
    if (!selection) return;
    const handleScroll = () => { if (!annotationModeRef.current) setSelection(null); };
    document.addEventListener('scroll', handleScroll, true);
    return () => document.removeEventListener('scroll', handleScroll, true);
  }, [selection]);

  // Click-away dismisses popover
  useEffect(() => {
    if (!selection) return;
    const handleClick = () => { if (!annotationModeRef.current) setSelection(null); };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [selection]);

  // ESC dismisses
  useEffect(() => {
    if (!selection) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !annotationModeRef.current) {
        e.preventDefault();
        setSelection(null);
      }
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [selection]);

  return {
    selection,
    annotationMode,
    annotationText,
    setAnnotationText: setAnnotationText,
    enterAnnotationMode,
    submitAnnotation,
    cancelAnnotation: clearAll,
    clear: clearAll,
  };
}

export function FileViewerTab({ path, relativePath: relPath, line }: FileViewerTabProps): React.JSX.Element {
  const transport = useTransport();
  const tabController = useTabControllerOptional();
  const envKind = useEnvironment();
  const [file, setFile] = useState<ActiveFileView | null>(null);
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const annotation = useFileViewerSelection(bodyRef, file);

  const ext = (path.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  const isImage = isImageExtension(ext);

  // Load file on mount or when path changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setImageDataUri(null);

    if (isImage) {
      transport.readImage(path).then(({ data, mimeType }) => {
        if (cancelled) return;
        setImageDataUri(`data:${mimeType};base64,${data}`);
        setLoading(false);
      }).catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    } else {
      transport.readFile(path).then(({ content, size }) => {
        if (cancelled) return;
        const relativePath = relPath ?? path.split('/').pop() ?? path;
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
    }

    return () => { cancelled = true; };
  }, [path, transport, isImage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update line when config changes (e.g. clicking same file at different line)
  useEffect(() => {
    if (file && line !== file.line) {
      setFile(prev => prev ? { ...prev, line } : prev);
    }
  }, [line]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExecute = useCallback(() => {
    if (!file) return;
    if (envKind === 'vscode') {
      // VS Code: clear current session and prefill input via postMessage
      window.postMessage({ kind: 'executeInCrispy', content: file.content }, '*');
    } else if (tabController) {
      // Standalone/desktop: open in a new tab with prefilled content
      tabController.createTab({ config: { prefillContent: file.content } });
    }
  }, [file, tabController, envKind]);

  const handleInsertIntoChat = useCallback(() => {
    if (!file) return;
    const annotation = `From \`${file.relativePath}\`:\n\`\`\`\`${file.language}\n${file.content}\n\`\`\`\`\n`;
    window.postMessage({ kind: 'insertIntoChat', text: annotation }, '*');
  }, [file]);

  const isMarkdownFile = !isImage && file ? /\.(md|markdown)$/i.test(file.relativePath) : false;
  const showExecute = !isImage && file && isExecutable(file.relativePath);

  return (
    <div className="crispy-file-viewer-tab">
      <div className="crispy-file-viewer-tab__toolbar">
        <span className="crispy-file-viewer-tab__path" title={path}>
          {file?.relativePath ?? relPath ?? (loading ? 'Loading...' : isImage ? (path.split('/').pop() ?? path) : 'Error')}
        </span>
        <div className="crispy-file-viewer-tab__actions">
          {file && !isImage && (
            <>
              {!markdownPreview && (
                <button
                  className={`crispy-file-viewer-tab__btn${wordWrap ? ' crispy-file-viewer-tab__btn--active' : ''}`}
                  onClick={() => setWordWrap(w => !w)}
                  title="Toggle word wrap"
                >
                  Wrap
                </button>
              )}
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
      <div className="crispy-file-viewer-tab__body" ref={bodyRef} data-word-wrap={wordWrap ? '' : undefined}>
        {loading ? (
          <div className="crispy-file-viewer">
            <div className="crispy-file-viewer__loading">Loading...</div>
          </div>
        ) : error ? (
          <div className="crispy-file-viewer">
            <div className="crispy-file-viewer__error">{error}</div>
          </div>
        ) : imageDataUri ? (
          <div className="crispy-file-viewer crispy-file-viewer--image">
            <img src={imageDataUri} alt={relPath ?? path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          </div>
        ) : file ? (
          <FileViewer file={file} error={error} loading={loading} wordWrap={wordWrap} markdownPreview={markdownPreview} />
        ) : null}
      </div>
      <TranscriptAnnotationPopover {...annotation} />
    </div>
  );
}
