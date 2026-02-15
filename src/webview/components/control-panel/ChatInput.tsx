/**
 * Chat Input — auto-resizing textarea with send button
 *
 * Textarea auto-grows up to 300px. Ctrl+Enter triggers send.
 * Send button uses hover jiggle animation.
 * Supports @-mention autocomplete for file paths.
 *
 * @module control-panel/ChatInput
 */

import { useRef, useLayoutEffect, useEffect, useState, useCallback } from 'react';
import type { AttachedImage } from './types.js';
import { ForkIcon } from './icons.js';
import { useMention } from '../../hooks/useMention.js';
import { MentionDropdown } from './MentionDropdown.js';

interface ChatInputProps {
  value: string;
  attachedImages: AttachedImage[];
  onInput: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  forkMode?: boolean;
  onFork?: () => void;
}

export function ChatInput({ value, attachedImages, onInput, onSend, placeholder, forkMode, onFork }: ChatInputProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [hoverClass, setHoverClass] = useState('');
  const mention = useMention(textareaRef, value, onInput);

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Focus textarea when host sends focusInput message (e.g. keybinding, panel activation)
  // Prefill textarea when host sends prefillInput message (e.g. "Execute in Crispy")
  useEffect(() => {
    function onMessage(ev: MessageEvent): void {
      if (ev.data?.kind === 'focusInput') {
        textareaRef.current?.focus();
      }
      if (ev.data?.kind === 'prefillInput' && ev.data.content) {
        onInput(ev.data.content);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onInput]);

  // Auto-resize textarea when value changes
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    el.style.height = Math.min(scrollH, 300) + 'px';
    el.style.overflowY = scrollH > 300 ? 'auto' : 'hidden';
  }, [value]);

  // Click-outside dismissal for mention dropdown
  useEffect(() => {
    if (!mention.active) return;
    function onMouseDown(e: MouseEvent): void {
      const inputRow = textareaRef.current?.closest('.crispy-cp-input-row');
      if (inputRow && !inputRow.contains(e.target as Node)) {
        mention.dismiss();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [mention.active, mention.dismiss]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Let mention hook consume keys first
      if (mention.handleKeyDown(e)) return;

      // Ctrl+Shift+Enter: fork
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        onFork?.();
        return;
      }
      // Ctrl+Enter: send
      if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend, onFork, mention.handleKeyDown],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onInput(e.target.value);
      mention.handleInputChange(e.target);
    },
    [onInput, mention.handleInputChange],
  );

  const isEmpty = !value.trim() && attachedImages.length === 0;

  return (
    <div className="crispy-cp-input-row">
      {mention.active && (mention.results.length > 0 || mention.query.length > 0) && (
        <MentionDropdown
          results={mention.results}
          selectedIndex={mention.selectedIndex}
          query={mention.query}
          onSelect={mention.selectItem}
        />
      )}
      <textarea
        ref={textareaRef}
        className="crispy-cp-input"
        placeholder={placeholder ?? "Ask Claude anything..."}
        rows={1}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={(e) => mention.handleInputChange(e.currentTarget)}
      />
      <button
        className={`crispy-cp-send ${forkMode ? 'crispy-cp-send--fork' : ''}`}
        title={forkMode ? "Send forked message (Ctrl+Enter)" : "Send message (Ctrl+Enter)"}
        disabled={isEmpty}
        onClick={onSend}
        onMouseEnter={() => setHoverClass('hovering')}
        onMouseLeave={() => setHoverClass('hover-out')}
      >
        <span className={`crispy-cp-send__icon ${hoverClass}`}>
          {forkMode ? <ForkIcon /> : <>&#9654;</>}
        </span>
      </button>
    </div>
  );
}
