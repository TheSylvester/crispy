/**
 * useTranscriptAnnotation — text selection + annotation for assistant responses
 *
 * Detects text selection within assistant transcript entries, shows a popover,
 * and formats the selection as a blockquote for insertion into chat input.
 * Uses the CSS Custom Highlight API for persistent visual highlighting during
 * annotation mode (no DOM mutation — safe for React reconciliation).
 *
 * @module hooks/useTranscriptAnnotation
 */

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { useIsActiveTab } from '../context/TabContainerContext.js';

export interface TranscriptSelection {
  text: string;
  rect: DOMRect;
  range: Range;
  isCodeBlock: boolean;
  entryUuid: string;
}

interface UseTranscriptAnnotationOpts {
  scrollRef: RefObject<HTMLDivElement | null>;
  onInsert: (text: string) => void;
  enabled: boolean;
}

export interface TranscriptAnnotationState {
  selection: TranscriptSelection | null;
  annotationMode: boolean;
  annotationText: string;
  setAnnotationText: (t: string) => void;
  enterAnnotationMode: () => void;
  submitAnnotation: () => void;
  cancelAnnotation: () => void;
  clear: () => void;
}

// Per-tab highlight key counter — each hook instance gets a unique key
// to avoid cross-tab CSS.highlights collisions.
let highlightCounter = 0;

function applyHighlight(key: string, range: Range): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const highlights = (CSS as any).highlights;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  highlights.set(key, new (window as any).Highlight(range));
}

function clearHighlight(key: string): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (CSS as any).highlights.delete(key);
}

/** Walk up from a node to the nearest `.message[data-uuid]` ancestor */
function findMessageAncestor(node: Node): { element: Element; uuid: string } | null {
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current && current instanceof Element) {
    if (current.matches('.message[data-uuid]')) {
      const uuid = current.getAttribute('data-uuid');
      if (uuid) return { element: current, uuid };
    }
    current = current.parentElement;
  }
  return null;
}

/** Check if a node is inside an element matching a selector */
function hasAncestor(node: Node, selector: string): boolean {
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current && current instanceof Element) {
    if (current.matches(selector)) return true;
    current = current.parentElement;
  }
  return false;
}

function formatAnnotation(text: string, _isCodeBlock: boolean, comment: string): string {
  let annotation = `\`\`\`\`\n${text}\n\`\`\`\`\n`;
  if (comment) {
    const lines = comment.split('\n');
    annotation += lines.map(line => `* ${line}`).join('\n') + '\n';
  }
  return annotation + '\n';
}

export function useTranscriptAnnotation(opts: UseTranscriptAnnotationOpts): TranscriptAnnotationState {
  const { scrollRef, onInsert, enabled } = opts;
  const isActiveTab = useIsActiveTab();
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const annotationModeRef = useRef(false);
  annotationModeRef.current = annotationMode;

  // Stable per-instance highlight key — avoids cross-tab CSS.highlights collisions
  const highlightKeyRef = useRef(`crispy-transcript-annotation-${++highlightCounter}`);
  const hk = highlightKeyRef.current;

  const clearAll = useCallback(() => {
    setSelection(null);
    setAnnotationMode(false);
    setAnnotationText('');
    clearHighlight(hk);
  }, [hk]);

  const enterAnnotationMode = useCallback(() => {
    if (selection) {
      applyHighlight(hk, selection.range);
      window.getSelection()?.removeAllRanges();
    }
    setAnnotationMode(true);
  }, [selection, hk]);

  const submitAnnotation = useCallback(() => {
    if (!selection) return;
    const output = formatAnnotation(selection.text, selection.isCodeBlock, annotationText.trim());
    onInsert(output);
    clearAll();
  }, [selection, annotationText, onInsert, clearAll]);

  const cancelAnnotation = useCallback(() => {
    clearAll();
  }, [clearAll]);

  // mouseup listener — detect valid selections in assistant entries
  useEffect(() => {
    if (!enabled || !isActiveTab) return;

    const handleMouseUp = () => {
      requestAnimationFrame(() => {
        if (annotationModeRef.current) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;

        const range = sel.getRangeAt(0);
        const text = sel.toString().trim();
        if (!text) return;

        // Scope check: both endpoints must be inside the transcript container
        const container = scrollRef.current;
        if (!container) return;
        if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;

        // Boundary detection: walk up independently from both endpoints
        const startMsg = findMessageAncestor(range.startContainer);
        const endMsg = findMessageAncestor(range.endContainer);
        if (!startMsg || !endMsg) return;
        if (startMsg.uuid !== endMsg.uuid) return;

        // Role check: must be assistant
        if (!startMsg.element.classList.contains('assistant')) return;

        // Detect code block
        const isCodeBlock = hasAncestor(range.startContainer, '.md-code-block');

        const rect = range.getBoundingClientRect();
        setSelection({
          text,
          rect,
          range: range.cloneRange(),
          isCodeBlock,
          entryUuid: startMsg.uuid,
        });
      });
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [enabled, isActiveTab, scrollRef]);

  // Scroll listener (capture phase) — dismiss popover on scroll
  useEffect(() => {
    if (!enabled || !isActiveTab) return;

    const handleScroll = () => {
      if (annotationModeRef.current) return;
      setSelection(null);
    };

    document.addEventListener('scroll', handleScroll, true);
    return () => document.removeEventListener('scroll', handleScroll, true);
  }, [enabled, isActiveTab]);

  // Click-away listener — dismiss popover when clicking outside
  // The popover's stopPropagation prevents clicks inside it from bubbling,
  // so this only fires for clicks outside the popover.
  useEffect(() => {
    if (!enabled || !isActiveTab || !selection) return;

    const handleClickAway = () => {
      if (annotationModeRef.current) return;
      setSelection(null);
    };

    document.addEventListener('click', handleClickAway);
    return () => document.removeEventListener('click', handleClickAway);
  }, [enabled, isActiveTab, selection]);

  // ESC listener — dismiss popover (except when typing in textarea)
  useEffect(() => {
    if (!enabled || !isActiveTab || !selection) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !annotationModeRef.current) {
        e.preventDefault();
        setSelection(null);
      }
    };

    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [enabled, isActiveTab, selection]);

  // Clear selection when tab becomes inactive — prevents portal popovers
  // from surviving tab switches and appearing over the wrong tab.
  useEffect(() => {
    if (!isActiveTab && selection) {
      clearAll();
    }
  }, [isActiveTab, selection, clearAll]);

  // Cleanup on unmount
  useEffect(() => {
    const key = hk;
    return () => clearHighlight(key);
  }, [hk]);

  return {
    selection,
    annotationMode,
    annotationText,
    setAnnotationText,
    enterAnnotationMode,
    submitAnnotation,
    cancelAnnotation,
    clear: clearAll,
  };
}
