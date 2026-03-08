/**
 * Chat Input — auto-resizing textarea with send button and voice input
 *
 * Textarea auto-grows up to 300px. Ctrl+Enter triggers send.
 * Send button uses hover jiggle animation.
 * Supports @-mention autocomplete for file paths.
 * Mic button toggles push-to-talk voice recording.
 *
 * @module control-panel/ChatInput
 */

import { useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import type { AttachedImage } from './types.js';
import { ForkIcon, MicIcon } from './icons.js';
import { useMention } from '../../hooks/useMention.js';
import { MentionDropdown } from './MentionDropdown.js';
import type { VoiceState } from '../../hooks/useVoiceInput.js';

interface ChatInputProps {
  value: string;
  attachedImages: AttachedImage[];
  onInput: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  forkMode?: boolean;
  onFork?: () => void;
  /** Voice input state — 'idle' | 'recording' | 'transcribing'. */
  voiceState?: VoiceState;
  /** Toggle voice recording on/off. */
  onVoiceToggle?: () => void;
}

export function ChatInput({ value, attachedImages, onInput, onSend, placeholder, forkMode, onFork, voiceState = 'idle', onVoiceToggle }: ChatInputProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMention(textareaRef, value, onInput);

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Handle host messages: focusInput (keybinding, panel activation), toggleVoiceInput (VS Code keybinding)
  useEffect(() => {
    function onMessage(ev: MessageEvent): void {
      if (ev.data?.kind === 'focusInput') {
        textareaRef.current?.focus();
      } else if (ev.data?.kind === 'toggleVoiceInput') {
        onVoiceToggle?.();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onVoiceToggle]);

  // Auto-resize textarea when value changes
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    el.style.height = Math.min(scrollH, 300) + 'px';
    el.style.overflowY = scrollH > 300 ? 'auto' : 'hidden';
    requestAnimationFrame(() => { el.style.transition = ''; });
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

  const micTitle = voiceState === 'recording'
    ? 'Stop recording (Ctrl+Shift+Space)'
    : voiceState === 'transcribing'
      ? 'Transcribing...'
      : 'Voice input (Ctrl+Shift+Space)';

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
        placeholder={placeholder ?? "What would you like to build?"}
        rows={1}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={(e) => mention.handleInputChange(e.currentTarget)}
      />
      {onVoiceToggle && (
        <button
          className={`crispy-cp-mic ${voiceState !== 'idle' ? `crispy-cp-mic--${voiceState}` : ''}`}
          title={micTitle}
          disabled={voiceState === 'transcribing'}
          onClick={onVoiceToggle}
          type="button"
        >
          <MicIcon />
        </button>
      )}
      <button
        className={`crispy-cp-send ${forkMode ? 'crispy-cp-send--fork' : ''}`}
        title={forkMode ? "Send forked message (Ctrl+Enter)" : "Send message (Ctrl+Enter)"}
        disabled={isEmpty}
        onClick={onSend}
      >
        <span className="crispy-cp-send__icon">
          {forkMode ? <ForkIcon /> : <>&#9654;</>}
        </span>
      </button>
    </div>
  );
}
