/**
 * Chat Input — auto-resizing textarea with send button
 *
 * Textarea auto-grows up to 300px. Ctrl+Enter triggers send.
 * Send button uses hover jiggle animation.
 *
 * @module control-panel/ChatInput
 */

import { useRef, useLayoutEffect, useState, useCallback } from 'react';
import type { AttachedImage } from './types.js';

interface ChatInputProps {
  value: string;
  attachedImages: AttachedImage[];
  onInput: (value: string) => void;
  onSend: () => void;
}

export function ChatInput({ value, attachedImages, onInput, onSend }: ChatInputProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [hoverClass, setHoverClass] = useState('');

  // Auto-resize textarea when value changes
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    el.style.height = Math.min(scrollH, 300) + 'px';
    el.style.overflowY = scrollH > 300 ? 'auto' : 'hidden';
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend],
  );

  const isEmpty = !value.trim() && attachedImages.length === 0;

  return (
    <div className="crispy-cp-input-row">
      <textarea
        ref={textareaRef}
        className="crispy-cp-input"
        placeholder="Ask Claude anything..."
        rows={1}
        value={value}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        className="crispy-cp-send"
        title="Send message (Ctrl+Enter)"
        disabled={isEmpty}
        onClick={onSend}
        onMouseEnter={() => setHoverClass('hovering')}
        onMouseLeave={() => setHoverClass('hover-out')}
      >
        <span className={`crispy-cp-send__icon ${hoverClass}`}>&#9654;</span>
      </button>
    </div>
  );
}
