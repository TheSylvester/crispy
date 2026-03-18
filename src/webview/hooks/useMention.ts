/**
 * useMention — @-mention autocomplete hook for chat input
 *
 * Manages activation (scan backward for `@`), filtering via FileIndex.search(),
 * keyboard navigation, and selection.
 *
 * @module hooks/useMention
 */

import { useState, useMemo, useCallback, type RefObject } from 'react';
import { useFileIndex } from '../context/FileIndexContext.js';
import type { FileMatch } from '../utils/file-index.js';

interface MentionState {
  active: boolean;
  query: string;
  atPosition: number; // index of `@` in textarea value
}

export interface UseMentionReturn {
  /** Whether the mention dropdown is active. */
  active: boolean;
  /** Filtered file results. */
  results: FileMatch[];
  /** Currently selected index. */
  selectedIndex: number;
  /** The current query (text after @). */
  query: string;
  /** Call on every input change — activates/deactivates mention mode. */
  handleInputChange: (textarea: HTMLTextAreaElement) => void;
  /** Call in onKeyDown — returns true if the key was consumed. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Select a result by index. */
  selectItem: (index: number) => void;
  /** Dismiss the dropdown. */
  dismiss: () => void;
}

const INACTIVE: MentionState = { active: false, query: '', atPosition: 0 };

/**
 * Check if a character is valid within a file path query.
 * Rejects whitespace and @ (mention trigger) — allows everything else
 * including emoji and unicode characters in filenames.
 */
function isPathChar(ch: string): boolean {
  return ch.length > 0 && !/[\s@]/.test(ch);
}

/**
 * Scan backward from cursor to find the nearest `@` with only valid path chars
 * between it and the cursor. The `@` must be at position 0 or preceded by
 * whitespace to avoid false positives on email-like text.
 * Returns the position of `@`, or -1 if not found.
 */
function findAtTrigger(text: string, cursorPos: number): number {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      // Require start of text or whitespace before @
      if (i === 0 || /\s/.test(text[i - 1])) return i;
      return -1;
    }
    if (!isPathChar(ch)) return -1;
  }
  return -1;
}

export function useMention(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  _value: string,
  onInput: (value: string) => void,
): UseMentionReturn {
  const fileIndex = useFileIndex();
  const [state, setState] = useState<MentionState>(INACTIVE);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter results from file index
  const results = useMemo(() => {
    if (!state.active || !fileIndex) return [];
    return fileIndex.search(state.query, 15);
  }, [state.active, state.query, fileIndex]);

  const dismiss = useCallback(() => {
    setState(INACTIVE);
    setSelectedIndex(0);
  }, []);

  const handleInputChange = useCallback((textarea: HTMLTextAreaElement) => {
    if (!fileIndex) {
      setState(INACTIVE);
      return;
    }

    const cursorPos = textarea.selectionStart;
    const text = textarea.value;
    const atPos = findAtTrigger(text, cursorPos);

    if (atPos === -1) {
      setState(INACTIVE);
      setSelectedIndex(0);
      return;
    }

    const query = text.slice(atPos + 1, cursorPos);
    setState({ active: true, query, atPosition: atPos });
    setSelectedIndex(0);
  }, [fileIndex]);

  const selectItem = useCallback((index: number) => {
    const textarea = textareaRef.current;
    if (!textarea || !state.active) return;

    const file = results[index];
    if (!file) return;

    const text = textarea.value;
    const beforeAt = text.slice(0, state.atPosition);
    const afterQuery = text.slice(state.atPosition + 1 + state.query.length);
    const insertion = `@${file.relativePath} `;
    const newValue = beforeAt + insertion + afterQuery;
    const newCursorPos = state.atPosition + insertion.length;

    onInput(newValue);
    setState(INACTIVE);
    setSelectedIndex(0);

    // Restore cursor position after React re-render (same pattern as insertAtCursor)
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = newCursorPos;
      textarea.focus();
    });
  }, [textareaRef, state, results, onInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!state.active) return false;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        dismiss();
        return true;

      case 'ArrowDown':
        if (results.length === 0) return false;
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % results.length);
        return true;

      case 'ArrowUp':
        if (results.length === 0) return false;
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
        return true;

      case 'Enter':
      case 'Tab':
        // Let Ctrl+Enter (send) and Ctrl+Shift+Enter (fork) pass through
        if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
        if (results.length === 0) return false;
        e.preventDefault();
        selectItem(selectedIndex);
        return true;

      default:
        return false;
    }
  }, [state.active, results, selectedIndex, selectItem, dismiss]);

  return {
    active: state.active,
    results,
    selectedIndex,
    query: state.query,
    handleInputChange,
    handleKeyDown,
    selectItem,
    dismiss,
  };
}
