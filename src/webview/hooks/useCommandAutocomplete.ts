/**
 * useCommandAutocomplete — slash/dollar command autocomplete for chat input
 *
 * Mirrors useMention.ts for @-file completion. Triggers on "/" (Claude)
 * at position 0 or after newline, or "$" (Codex) at position 0 or after whitespace.
 *
 * @module webview/hooks/useCommandAutocomplete
 */

import { useState, useCallback, useEffect, useMemo, type RefObject } from 'react';
import { useTransport } from '../context/TransportContext.js';
import type { InputCommand } from '../transport.js';

interface CommandState {
  active: boolean;
  query: string;
  triggerPos: number; // index of trigger char in textarea value
}

export interface UseCommandAutocompleteReturn {
  active: boolean;
  query: string;
  filtered: InputCommand[];
  selectedIndex: number;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  handleInputChange: (target: HTMLTextAreaElement) => void;
  selectItem: (index: number) => void;
  dismiss: () => void;
}

const INACTIVE: CommandState = { active: false, query: '', triggerPos: 0 };

function isCommandChar(ch: string): boolean {
  return /^[a-z0-9-]$/.test(ch);
}

function findCommandTrigger(
  text: string, cursorPos: number, triggerChar: '/' | '$',
): number {
  // Build array of [codepoint, utf16Offset] up to cursorPos
  const entries: [string, number][] = [];
  let offset = 0;
  for (const ch of text) {
    if (offset >= cursorPos) break;
    entries.push([ch, offset]);
    offset += ch.length;
  }

  // Scan backwards for trigger char
  for (let i = entries.length - 1; i >= 0; i--) {
    const [ch, utf16Pos] = entries[i];
    if (ch === triggerChar) {
      if (triggerChar === '/') {
        // / only at position 0 or after newline
        if (i === 0 || entries[i - 1][0] === '\n') return utf16Pos;
      } else {
        // $ at position 0 or after whitespace
        if (i === 0 || /\s/.test(entries[i - 1][0])) return utf16Pos;
      }
      return -1;
    }
    if (!isCommandChar(ch)) return -1;
  }
  return -1;
}

export function useCommandAutocomplete(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  _value: string,
  onInput: (value: string) => void,
  vendor: string | null,
): UseCommandAutocompleteReturn {
  const transport = useTransport();
  const [commands, setCommands] = useState<InputCommand[]>([]);
  const [state, setState] = useState<CommandState>(INACTIVE);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Fetch commands when vendor changes
  useEffect(() => {
    if (!vendor) {
      setCommands([]);
      return;
    }
    let stale = false;
    transport.listAvailableCommands({ vendor })
      .then(cmds => { if (!stale) setCommands(cmds); })
      .catch(() => { if (!stale) setCommands([]); });
    return () => { stale = true; };
  }, [transport, vendor]);

  // Filter commands by query (memoized to stabilize reference for downstream consumers)
  const filtered = useMemo(() => {
    if (!state.active) return [];
    if (!state.query) return commands;
    const q = state.query.toLowerCase();
    return commands.filter(cmd =>
      cmd.id.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q),
    );
  }, [state.active, state.query, commands]);

  const dismiss = useCallback(() => {
    setState(INACTIVE);
    setSelectedIndex(0);
  }, []);

  const handleInputChange = useCallback((textarea: HTMLTextAreaElement) => {
    if (commands.length === 0) {
      setState(INACTIVE);
      return;
    }

    const cursorPos = textarea.selectionStart;
    const text = textarea.value;

    // Determine trigger char from the first command (all share the same trigger per vendor)
    const triggerChar = commands[0]?.trigger ?? '/';
    const triggerPos = findCommandTrigger(text, cursorPos, triggerChar);

    if (triggerPos === -1) {
      setState(INACTIVE);
      setSelectedIndex(0);
      return;
    }

    const query = text.slice(triggerPos + 1, cursorPos);
    setState({ active: true, query, triggerPos });
    setSelectedIndex(0);
  }, [commands]);

  const selectItem = useCallback((index: number) => {
    const textarea = textareaRef.current;
    if (!textarea || !state.active) return;

    const cmd = filtered[index];
    if (!cmd) return;

    const text = textarea.value;
    const beforeTrigger = text.slice(0, state.triggerPos);
    const afterQuery = text.slice(state.triggerPos + 1 + state.query.length);
    const insertion = cmd.insertText;
    const newValue = beforeTrigger + insertion + afterQuery;
    const newCursorPos = state.triggerPos + insertion.length;

    onInput(newValue);
    setState(INACTIVE);
    setSelectedIndex(0);

    // Restore cursor position after React re-render
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = newCursorPos;
      textarea.focus();
    });
  }, [textareaRef, state, filtered, onInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!state.active) return false;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        dismiss();
        return true;

      case 'ArrowDown':
        if (filtered.length === 0) return false;
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filtered.length);
        return true;

      case 'ArrowUp':
        if (filtered.length === 0) return false;
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
        return true;

      case 'Enter':
      case 'Tab':
        // Let Ctrl+Enter (send) and Ctrl+Shift+Enter (fork) pass through
        if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
        if (filtered.length === 0) return false;
        e.preventDefault();
        selectItem(selectedIndex);
        return true;

      default:
        return false;
    }
  }, [state.active, filtered, selectedIndex, selectItem, dismiss]);

  return {
    active: state.active,
    query: state.query,
    filtered,
    selectedIndex,
    handleKeyDown,
    handleInputChange,
    selectItem,
    dismiss,
  };
}
