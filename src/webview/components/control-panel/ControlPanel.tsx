/**
 * Control Panel — floating bottom-center bar with chat input and controls
 *
 * Parent shell that composes all control sub-components. Uses useReducer
 * for coupled cross-field state (bypass ↔ agency mode). Send is wired to
 * transport — submitting the chat input calls transport.send() with the
 * active session. Other controls remain local/visual-only.
 *
 * Two rows:
 * - Row 1: Auto-resizing textarea + send button + image attachment chips
 * - Row 2: Bypass | Agency | Model | File Context | Context | Chrome | Settings | Fork
 *
 * @module control-panel/ControlPanel
 */

import { useReducer, useEffect, useCallback, useRef, forwardRef, useState } from 'react';
import {
  type ControlPanelState,
  type Action,
  type AgencyMode,
  type ModelOption,
  type AttachedImage,
  DEFAULT_CONTROL_PANEL_STATE,
  mapAgencyToPermissionMode,
  mapPermissionModeToAgency,
} from './types.js';
import { ChatInput } from './ChatInput.js';
import { AttachmentsRow } from './AttachmentsRow.js';
import { BypassToggle } from './BypassToggle.js';
import { AgencyModeSelect } from './AgencyModeSelect.js';
import { ModelSelect } from './ModelSelect.js';
import { FileContextToggle } from './FileContextToggle.js';
import { ContextWidget } from './ContextWidget.js';
import { ChromeToggle } from './ChromeToggle.js';
import { SettingsPopup } from './SettingsPopup.js';
import { ForkButton } from './ForkButton.js';
import { usePreferences } from '../../context/PreferencesContext.js';
import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { slugToPath } from '../../hooks/useSessionCwd.js';
import { useContextUsage } from '../../hooks/useContextUsage.js';
import { useSessionStatus } from '../../hooks/useSessionStatus.js';
import { extractFilePathsFromDragEvent, isImageExtension } from '../../utils/drag-drop.js';
import type { MessageContent, MessageContentBlock, ContentBlock, TranscriptEntry } from '../../../core/transcript.js';

/**
 * Build an optimistic TranscriptEntry for immediate rendering before backend echo.
 *
 * Pure function — no React hooks. Handles both text-only and multimodal content.
 * The returned entry uses a `uuid` prefixed with "optimistic-" so useTranscript's
 * dedup logic can replace it when the real backend echo arrives.
 */
export function buildOptimisticUserEntry(sessionId: string, content: MessageContent): TranscriptEntry {
  const contentBlocks: ContentBlock[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content.map((block): ContentBlock =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'image', source: { type: block.source.type, media_type: block.source.media_type, data: block.source.data } }
      );

  return {
    type: 'user',
    uuid: `optimistic-${Date.now()}`,
    sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: contentBlocks,
    },
  };
}

interface ControlPanelProps {
  onForkHoverChange?: (hovering: boolean) => void;
  /** Inject an optimistic user entry into the transcript before backend echo. */
  onOptimisticEntry?: (entry: TranscriptEntry) => void;
  /** Stash an optimistic entry for injection after a new session initializes. */
  onPendingOptimisticEntry?: (entry: TranscriptEntry) => void;
  /** Instantly pin transcript scroll to bottom (called on send). */
  onScrollToBottom?: () => void;
  /** Transcript entries for historical context usage fallback. */
  entries?: TranscriptEntry[];
  /** Slot: when provided, replaces AttachmentsRow + ChatInput (approval mode). */
  children?: React.ReactNode;
  /** Notify parent when bypass state changes (for ExitPlanMode approval). */
  onBypassChange?: (enabled: boolean) => void;
  /** Pre-fill the ChatInput with content (for ExitPlanMode handoff). Consumed once. */
  prefillInput?: { text: string; autoSend?: boolean } | null;
  /** Called after prefillInput is consumed, allowing the parent to clear it. */
  onPrefillConsumed?: () => void;
  /** Called when fork history entries are loaded for pre-display. */
  onForkHistoryLoaded?: (entries: TranscriptEntry[]) => void;
  /** Register a handler for per-message fork execution (called from ForkContext). */
  onRegisterForkHandler?: (handler: (atMessageId: string) => void) => void;
  /** Register a handler for per-message rewind execution (fork-in-same-panel). */
  onRegisterRewindHandler?: (handler: (atMessageId: string) => void) => void;
  /** Push agency mode + bypass state from ExitPlanMode handoff. Consumed once. */
  pendingAgencyMode?: { agencyMode: AgencyMode; bypassEnabled: boolean } | null;
  /** Called after pendingAgencyMode is consumed. */
  onPendingAgencyModeConsumed?: () => void;
}

/** Agency modes for keyboard cycling (excluding bypass-permissions). */
const CYCLABLE_AGENCY_MODES: AgencyMode[] = [
  'plan-mode',
  'edit-automatically',
  'ask-before-edits',
];

/** Model options for keyboard cycling. */
const CYCLABLE_MODELS: ModelOption[] = ['', 'opus', 'sonnet', 'haiku'];

function controlPanelReducer(state: ControlPanelState, action: Action): ControlPanelState {
  switch (action.type) {
    case 'SET_BYPASS': {
      if (action.enabled) {
        return { ...state, bypassEnabled: true, agencyMode: 'bypass-permissions' };
      }
      return {
        ...state,
        bypassEnabled: false,
        agencyMode: state.agencyMode === 'bypass-permissions' ? 'ask-before-edits' : state.agencyMode,
      };
    }
    case 'SET_AGENCY_MODE': {
      // Agency mode and bypass are independent axes — switching to plan mode
      // or accept-edits never turns OFF the bypass safety gate.
      // However, if the server tells us we're in bypass-permissions mode
      // (e.g., via permission_mode_changed), we must turn bypass ON to
      // reflect reality.
      return {
        ...state,
        agencyMode: action.mode,
        bypassEnabled: action.mode === 'bypass-permissions' ? true : state.bypassEnabled,
      };
    }
    case 'SET_MODEL':
      return { ...state, model: action.model };
    case 'SET_CHROME':
      return { ...state, chromeEnabled: action.enabled };
    case 'SET_INPUT':
      return { ...state, input: action.value };
    case 'CLEAR_INPUT':
      return { ...state, input: '', attachedImages: [], pastedImageCounter: 0, forkMode: null };
    case 'ADD_IMAGE':
      return { ...state, attachedImages: [...state.attachedImages, action.image] };
    case 'REMOVE_IMAGE':
      return {
        ...state,
        attachedImages: state.attachedImages.filter((img) => img.id !== action.id),
      };
    case 'CLEAR_IMAGES':
      return { ...state, attachedImages: [], pastedImageCounter: 0 };
    case 'INCREMENT_PASTE_COUNTER':
      return { ...state, pastedImageCounter: state.pastedImageCounter + 1 };
    case 'SET_FILE_CONTEXT':
      return { ...state, fileContextEnabled: action.enabled };
    case 'SET_CONTEXT':
      return { ...state, contextPercent: action.contextUsage.percent, contextUsage: action.contextUsage };
    case 'RESET_CONTEXT':
      return { ...state, contextPercent: 0, contextUsage: null };
    case 'SET_FORK_MODE':
      return { ...state, forkMode: action.forkMode };
    default:
      return state;
  }
}

export const ControlPanel = forwardRef<HTMLDivElement, ControlPanelProps>(
  function ControlPanel({ onForkHoverChange, onOptimisticEntry, onPendingOptimisticEntry, onScrollToBottom, entries, children, onBypassChange, prefillInput, onPrefillConsumed, onForkHistoryLoaded, onRegisterForkHandler, onRegisterRewindHandler, pendingAgencyMode, onPendingAgencyModeConsumed }, ref) {
    const [state, dispatch] = useReducer(controlPanelReducer, DEFAULT_CONTROL_PANEL_STATE);
    // Track the DOM element for native drag/drop listeners. A callback ref
    // ensures the useEffect re-runs when the element mounts, unlike a
    // RefObject whose identity never changes.
    const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
    const panelRefCallback = useCallback((node: HTMLDivElement | null) => {
      setPanelEl(node);
      // Forward to the parent-provided ref
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        (ref as React.RefObject<HTMLDivElement | null>).current = node;
      }
    }, [ref]);
    // Track the last permission mode we pushed to the server to avoid echo loops
    // with the permission_mode_changed event listener.
    const lastPushedModeRef = useRef<string | null>(null);
    const lastPushedModelRef = useRef<ModelOption>(state.model);
    const lastPushedBypassRef = useRef<boolean>(state.bypassEnabled);
    const lastPushedChromeRef = useRef<boolean>(state.chromeEnabled);
    const { renderMode, setRenderMode, settingsPinned, setSettingsPinned } = usePreferences();
    const transport = useTransport();
    const { selectedSessionId, selectedCwd, setSelectedSessionId } = useSession();
    const { channelState, setOptimistic: setOptimisticStatus } = useSessionStatus(selectedSessionId);
    const togglesDisabled = channelState === 'streaming' || channelState === 'awaiting_approval';

    // Clear forkMode when switching sessions
    useEffect(() => {
      dispatch({ type: 'SET_FORK_MODE', forkMode: null });
    }, [selectedSessionId]);

    // Ref to always call the latest handleSend (avoids stale closure in forkConfig auto-send)
    const handleSendRef = useRef<() => void>(() => {});

    /** Read current input from the textarea DOM — avoids closing over stale state. */
    const getTextareaState = useCallback(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.crispy-cp-input');
      return textarea
        ? { textarea, value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd }
        : null;
    }, []);

    /** Insert text at cursor position (or append), dispatch SET_INPUT, restore cursor. */
    const insertAtCursor = useCallback((text: string) => {
      const ts = getTextareaState();
      if (ts) {
        const newValue = ts.value.slice(0, ts.start) + text + ts.value.slice(ts.end);
        dispatch({ type: 'SET_INPUT', value: newValue });
        requestAnimationFrame(() => {
          ts.textarea.selectionStart = ts.textarea.selectionEnd = ts.start + text.length;
          ts.textarea.focus();
        });
      } else {
        // No textarea found — append to whatever the reducer currently holds.
        // Use a functional-style dispatch via a known-current DOM read.
        dispatch({ type: 'SET_INPUT', value: text });
      }
    }, [getTextareaState]);

    /** Read an image File into base64 and dispatch ADD_IMAGE (no text insertion). */
    const attachImageFile = useCallback((file: File, customName?: string) => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = (reader.result as string).split(',')[1] ?? '';
        const id = typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);
        const thumbnailUrl = URL.createObjectURL(file);
        const image: AttachedImage = {
          id,
          uri: '',
          fileName: customName ?? file.name,
          mimeType: file.type || 'image/png', // Fallback for missing MIME type
          data,
          thumbnailUrl,
        };
        dispatch({ type: 'ADD_IMAGE', image });
      };
      reader.readAsDataURL(file);
    }, []);

    // --- Notify parent of bypass state changes ---
    useEffect(() => {
      onBypassChange?.(state.bypassEnabled);
    }, [state.bypassEnabled, onBypassChange]);

    // --- Consume prefillInput when provided (ExitPlanMode handoff) ---
    useEffect(() => {
      if (prefillInput) {
        dispatch({ type: 'SET_INPUT', value: prefillInput.text });
        if (prefillInput.autoSend) {
          setTimeout(() => handleSendRef.current(), 50);
        }
        onPrefillConsumed?.();
      }
    }, [prefillInput, onPrefillConsumed]);

    // --- Consume pendingAgencyMode when provided (ExitPlanMode handoff) ---
    useEffect(() => {
      if (pendingAgencyMode) {
        dispatch({ type: 'SET_AGENCY_MODE', mode: pendingAgencyMode.agencyMode });
        dispatch({ type: 'SET_BYPASS', enabled: pendingAgencyMode.bypassEnabled });
        onPendingAgencyModeConsumed?.();
      }
    }, [pendingAgencyMode, onPendingAgencyModeConsumed]);

    // --- Context usage tracking ---
    const contextUsage = useContextUsage(selectedSessionId, entries);
    useEffect(() => {
      if (contextUsage) {
        dispatch({ type: 'SET_CONTEXT', contextUsage });
      } else {
        dispatch({ type: 'RESET_CONTEXT' });
      }
    }, [contextUsage]);

    // --- Keyboard shortcuts ---
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // Alt+`: Toggle bypass
        if (e.key === '`' && e.altKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          if (togglesDisabled) return;
          dispatch({ type: 'SET_BYPASS', enabled: !state.bypassEnabled });
          return;
        }

        // Alt+Q: Cycle agency modes
        if (e.key === 'q' && e.altKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          const modes = state.bypassEnabled
            ? [...CYCLABLE_AGENCY_MODES, 'bypass-permissions' as AgencyMode]
            : CYCLABLE_AGENCY_MODES;
          const idx = modes.indexOf(state.agencyMode);
          const next = modes[(idx + 1) % modes.length];
          dispatch({ type: 'SET_AGENCY_MODE', mode: next });
          return;
        }

        // Alt+M: Cycle models
        if (e.key === 'm' && e.altKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          const idx = CYCLABLE_MODELS.indexOf(state.model);
          const next = CYCLABLE_MODELS[(idx + 1) % CYCLABLE_MODELS.length];
          dispatch({ type: 'SET_MODEL', model: next });
          return;
        }
      };

      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [state.bypassEnabled, state.agencyMode, state.model, togglesDisabled]);

    // --- Server → UI: permission_mode_changed notifications ---
    // The control panel is the optimistic source of truth — the user's chosen
    // mode takes effect immediately on send(). The adapter suppresses the SDK
    // boot echo (where it reports its default before processing our request),
    // so every event that reaches here is a genuine server-initiated change
    // (e.g. agent called EnterPlanMode) and should be applied unconditionally.
    useEffect(() => {
      const off = transport.onEvent((sessionId, event) => {
        if (sessionId !== selectedSessionId) return;
        if (event.type === 'notification' && event.event.kind === 'permission_mode_changed') {
          const serverMode = mapPermissionModeToAgency(event.event.mode);
          if (serverMode) {
            // Update the ref so the push-to-server effect below doesn't echo
            lastPushedModeRef.current = mapAgencyToPermissionMode(serverMode);
            dispatch({ type: 'SET_AGENCY_MODE', mode: serverMode });
          }
        }
      });
      return off;
    }, [selectedSessionId, transport]);

    // --- Continuous settings sync from snapshot ---
    // Every state_changed snapshot carries the adapter's current settings.
    // We apply incoming settings whenever they differ from what this client
    // last pushed, so cross-client changes (another tab calling setModel,
    // setPermissions, or reconfigure) are reflected immediately. The
    // lastPushed*Ref guards prevent echo loops — the client that made the
    // change already updated its refs in the push effects, so the incoming
    // snapshot is a no-op for the originator.
    useEffect(() => {
      const off = transport.onEvent((sessionId, event) => {
        if (sessionId !== selectedSessionId) return;
        if (event.type !== 'state_changed' || !event.snapshot.settings) return;

        const { settings } = event.snapshot;

        // Skip empty settings — adapter hasn't received init yet.
        if (!settings.model && !settings.permissionMode) return;

        // Sync permission mode (skip if it matches our last push)
        if (settings.permissionMode) {
          const serverMode = mapPermissionModeToAgency(settings.permissionMode);
          if (serverMode && settings.permissionMode !== lastPushedModeRef.current) {
            lastPushedModeRef.current = mapAgencyToPermissionMode(serverMode);
            dispatch({ type: 'SET_AGENCY_MODE', mode: serverMode });
          }
        }

        // Sync model (skip if it matches our last push)
        const incomingModel = (settings.model ?? '') as ModelOption;
        if (incomingModel !== lastPushedModelRef.current) {
          lastPushedModelRef.current = incomingModel;
          dispatch({ type: 'SET_MODEL', model: incomingModel });
        }

        // Sync bypass (skip if it matches our last push)
        if (settings.allowDangerouslySkipPermissions !== lastPushedBypassRef.current) {
          lastPushedBypassRef.current = settings.allowDangerouslySkipPermissions;
          dispatch({ type: 'SET_BYPASS', enabled: settings.allowDangerouslySkipPermissions });
        }

        // Sync chrome (skip if it matches our last push)
        const chromeEnabled = settings.extraArgs?.chrome !== undefined;
        if (chromeEnabled !== lastPushedChromeRef.current) {
          lastPushedChromeRef.current = chromeEnabled;
          dispatch({ type: 'SET_CHROME', enabled: chromeEnabled });
        }
      });
      return off;
    }, [selectedSessionId, transport]);

    // --- Push agency mode changes to server immediately ---
    // Track what we last pushed to avoid echo loops with the
    // permission_mode_changed event listener above.
    useEffect(() => {
      if (!selectedSessionId) return;
      const mode = mapAgencyToPermissionMode(state.agencyMode);
      if (mode === lastPushedModeRef.current) return;
      lastPushedModeRef.current = mode;
      transport.setPermissions(selectedSessionId, mode).catch((err) => {
        console.error('[ControlPanel] setPermissions failed:', err);
      });
    }, [state.agencyMode, selectedSessionId, transport]);

    // --- Push bypass changes to server (triggers query restart) ---
    useEffect(() => {
      if (!selectedSessionId) return;
      if (channelState !== 'idle') return;
      if (state.bypassEnabled === lastPushedBypassRef.current) return;
      lastPushedBypassRef.current = state.bypassEnabled;
      transport.reconfigure(selectedSessionId, {
        allowDangerouslySkipPermissions: state.bypassEnabled,
      }).catch(err => console.error('[ControlPanel] reconfigure (bypass) failed:', err));
    }, [state.bypassEnabled, selectedSessionId, channelState, transport]);

    // --- Push Chrome changes to server (triggers query restart) ---
    useEffect(() => {
      if (!selectedSessionId) return;
      if (channelState !== 'idle') return;
      if (state.chromeEnabled === lastPushedChromeRef.current) return;
      lastPushedChromeRef.current = state.chromeEnabled;
      transport.reconfigure(selectedSessionId, {
        extraArgs: state.chromeEnabled ? { chrome: null } : {},
      }).catch(err => console.error('[ControlPanel] reconfigure (chrome) failed:', err));
    }, [state.chromeEnabled, selectedSessionId, channelState, transport]);

    // --- Send handler ---
    const handleSend = useCallback(() => {
      const text = state.input.trim();
      const hasImages = state.attachedImages.length > 0;
      if (!text && !hasImages) return;

      // Build MessageContent: plain string for text-only, block array for multimodal
      let content: MessageContent;
      if (hasImages) {
        const blocks: MessageContentBlock[] = [];
        // Images first — matches Claude Code's content order and Leto's visual layout
        for (const img of state.attachedImages) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.data },
          });
        }
        if (text) {
          blocks.push({ type: 'text', text });
        }
        content = blocks;
      } else {
        content = text;
      }

      // Options applied atomically with send() — model, permissions, bypass.
      const sendOptions = {
        model: state.model || undefined,
        permissionMode: mapAgencyToPermissionMode(state.agencyMode),
        allowDangerouslySkipPermissions: state.bypassEnabled || undefined,
      };

      // Mark what we're sending so the continuous settings sync ignores the
      // echo from our own send — only other clients adopt the change.
      lastPushedModelRef.current = state.model;

      /**
       * Shared flow for fork & new-session branches: inject pending optimistic
       * entry → create session via factory → select → scroll → send.
       */
      function createThenSend(
        sessionFactory: () => Promise<{ pendingId: string }>,
        errorLabel: string,
        onError?: () => void,
      ) {
        const optimistic = buildOptimisticUserEntry('pending', content);
        onPendingOptimisticEntry?.(optimistic);
        setOptimisticStatus('streaming');

        sessionFactory().then(({ pendingId }) => {
          setSelectedSessionId(pendingId);
          onScrollToBottom?.();
          return transport.send(pendingId, content, sendOptions);
        }).catch((err) => {
          setOptimisticStatus('idle');
          console.error(`[ControlPanel] ${errorLabel} failed:`, err);
          onError?.();
        });

        dispatch({ type: 'CLEAR_INPUT' });
      }

      // --- Fork branch: create forked session, then send ---
      if (state.forkMode) {
        const forkMode = state.forkMode;
        const { fromSessionId, atMessageId } = forkMode;

        createThenSend(
          () => transport.forkSession('claude', fromSessionId, { atMessageId }),
          'forkSession',
          () => {
            dispatch({ type: 'SET_INPUT', value: typeof content === 'string' ? content : text });
            dispatch({ type: 'SET_FORK_MODE', forkMode });
          },
        );
        return;
      }

      // --- New session branch: create session, then send ---
      if (!selectedSessionId) {
        if (!selectedCwd) {
          console.error('[ControlPanel] Cannot create session: no CWD selected');
          return;
        }
        const cwd = slugToPath(selectedCwd);

        createThenSend(
          () => transport.createSession('claude', cwd, {
            model: state.model || undefined,
            permissionMode: mapAgencyToPermissionMode(state.agencyMode),
            extraArgs: state.chromeEnabled ? { chrome: null } : undefined,
          }),
          'createSession',
        );
        return;
      }

      // --- Existing session: optimistic entry + send ---
      if (onOptimisticEntry) {
        onOptimisticEntry(buildOptimisticUserEntry(selectedSessionId, content));
      }
      onScrollToBottom?.();

      setOptimisticStatus('streaming');
      transport.send(selectedSessionId, content, sendOptions).catch((err) => {
        setOptimisticStatus('idle');
        console.error('[ControlPanel] send failed:', err);
      });

      dispatch({ type: 'CLEAR_INPUT' });
    }, [state.input, state.attachedImages, state.model, state.agencyMode, state.bypassEnabled, state.chromeEnabled, state.forkMode, selectedSessionId, selectedCwd, setSelectedSessionId, setOptimisticStatus, transport, onOptimisticEntry, onPendingOptimisticEntry, onScrollToBottom]);

    // Keep ref in sync so forkConfig auto-send always calls the latest handleSend
    useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

    // --- Drag/drop handlers (native addEventListener, not React props) ---
    //
    // Must use native addEventListener directly on the DOM element, not React's
    // onDragOver/onDrop props. React's event delegation attaches a single listener
    // at the root — the browser requires preventDefault() on the actual dragover
    // target synchronously for the element to be a valid drop zone. In VS Code
    // webviews (Electron iframes), React's indirection can cause the browser to
    // reject the drop silently. Leto uses native addEventListener and it works.
    //
    // Also matches Leto's dragleave strategy: relatedTarget check instead of a
    // counter, and drag-over class set in dragover (continuously reapplied) so
    // visual feedback is robust.

    useEffect(() => {
      if (!panelEl || children) return;

      const onDragOver = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        panelEl.classList.add('drag-over');
      };

      const onDragLeave = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Only remove class if cursor left the panel entirely (not entering a child).
        // Matches Leto's relatedTarget approach — simpler and more reliable than counters.
        const relatedTarget = e.relatedTarget as Node | null;
        if (!relatedTarget || !panelEl.contains(relatedTarget)) {
          panelEl.classList.remove('drag-over');
        }
      };

      const onDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        panelEl.classList.remove('drag-over');

        // Collect both data sources synchronously (getData() returns empty
        // strings if called after the event is released).
        const paths = extractFilePathsFromDragEvent(e);
        const fileObjects = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];

        // Identify images in fileObjects by MIME type OR extension (robustness for Linux).
        // Exclude SVG — the API only accepts raster formats (jpeg, png, gif, webp).
        const imageFiles = fileObjects.filter(f => {
          if (f.type === 'image/svg+xml') return false;
          if (f.type.startsWith('image/')) return true;
          const dotIdx = f.name.lastIndexOf('.');
          const ext = dotIdx >= 0 ? f.name.slice(dotIdx) : '';
          return isImageExtension(ext);
        });

        // --- Image File objects take priority (most reliable — works like paste) ---
        if (imageFiles.length > 0) {
          const placeholders: string[] = [];
          for (const file of imageFiles) {
            attachImageFile(file);
            placeholders.push(`[${file.name}]`);
          }
          // Handle non-image File objects (e.g. SVGs mixed with raster images)
          const imageFileSet = new Set(imageFiles);
          for (const file of fileObjects) {
            if (!imageFileSet.has(file)) {
              placeholders.push(`[${file.name}]`);
            }
          }
          // Also handle any non-image paths that came along
          for (const filePath of paths) {
            const dotIdx = filePath.lastIndexOf('.');
            const ext = dotIdx >= 0 ? filePath.slice(dotIdx) : '';
            // Skip paths that correspond to files we already processed
            const isAlreadyProcessed = fileObjects.some(f => filePath.endsWith(f.name));
            if (!isImageExtension(ext) && !isAlreadyProcessed) {
              placeholders.push(`'${filePath}'`);
            }
          }
          if (placeholders.length > 0) {
            insertAtCursor(placeholders.join(' '));
          }
          return;
        }

        // --- Non-image File objects with no extractable path (e.g. SVG from file manager) ---
        // Insert filenames as references so they aren't silently dropped.
        if (fileObjects.length > 0 && paths.length === 0) {
          const refs = fileObjects.map(f => `[${f.name}]`);
          insertAtCursor(refs.join(' '));
          return;
        }

        // --- Path-based drops (VS Code Explorer / editor tabs / WSL remote) ---
        if (paths.length > 0) {
          for (const filePath of paths) {
            const dotIdx = filePath.lastIndexOf('.');
            const ext = dotIdx >= 0 ? filePath.slice(dotIdx) : '';

            if (isImageExtension(ext)) {
              // No File objects available — read via transport as fallback
              transport.readImage(filePath).then(({ data, mimeType, fileName }) => {
                const id = typeof crypto !== 'undefined' && crypto.randomUUID
                  ? crypto.randomUUID()
                  : Math.random().toString(36).slice(2);
                const image: AttachedImage = {
                  id,
                  uri: filePath,
                  fileName,
                  mimeType,
                  data,
                  thumbnailUrl: `data:${mimeType};base64,${data}`,
                };
                dispatch({ type: 'ADD_IMAGE', image });
                insertAtCursor(`[${fileName}]`);
              }).catch((err) => {
                console.error('[ControlPanel] readImage failed:', err);
              });
            } else {
              insertAtCursor(`'${filePath}'`);
            }
          }
          return;
        }

        // Focus textarea after drop so user can immediately type
        const textarea = document.querySelector<HTMLTextAreaElement>('.crispy-cp-input');
        textarea?.focus();
      };

      panelEl.addEventListener('dragover', onDragOver);
      panelEl.addEventListener('dragleave', onDragLeave);
      panelEl.addEventListener('drop', onDrop);
      return () => {
        panelEl.removeEventListener('dragover', onDragOver);
        panelEl.removeEventListener('dragleave', onDragLeave);
        panelEl.removeEventListener('drop', onDrop);
        panelEl.classList.remove('drag-over');
      };
    }, [panelEl, children, transport, attachImageFile, insertAtCursor]);

    // --- Paste handler for images ---
    useEffect(() => {
      const handlePaste = (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        let localCounter = state.pastedImageCounter;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith('image/') && item.type !== 'image/svg+xml') {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;

            localCounter++;
            dispatch({ type: 'INCREMENT_PASTE_COUNTER' });

            const fileName = (!file.name || file.name === 'image.png')
              ? `image-${localCounter}.png`
              : file.name;

            const reader = new FileReader();
            reader.onload = () => {
              const data = (reader.result as string).split(',')[1] ?? '';
              const id = typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2);
              const thumbnailUrl = URL.createObjectURL(file);

              const image: AttachedImage = {
                id,
                uri: '',
                fileName,
                mimeType: file.type || 'image/png',
                data,
                thumbnailUrl,
              };
              dispatch({ type: 'ADD_IMAGE', image });

              // Insert text trail placeholder at cursor (like Leto)
              insertAtCursor(`[${fileName}]`);
            };
            reader.readAsDataURL(file);
          }
        }
      };

      document.addEventListener('paste', handlePaste);
      return () => document.removeEventListener('paste', handlePaste);
    }, [state.pastedImageCounter, insertAtCursor]);

    // --- forkConfig message listener (new panel created via fork) ---
    // Host retries delivery so the listener must be idempotent.
    // Settings dispatches are naturally idempotent; input prefill is idempotent.
    useEffect(() => {
      function onMessage(ev: MessageEvent) {
        if (ev.data?.kind === 'forkConfig') {
          const { fromSessionId, atMessageId, initialPrompt, model, agencyMode, bypassEnabled, chromeEnabled } = ev.data;

          // Set fork mode — this changes the send button (idempotent)
          dispatch({ type: 'SET_FORK_MODE', forkMode: { fromSessionId, atMessageId } });

          // Pull source session history truncated at fork point for immediate display.
          // This is visual-only — no session is created until the user sends.
          if (fromSessionId && onForkHistoryLoaded) {
            transport.loadSession(fromSessionId, atMessageId ? { until: atMessageId } : undefined)
              .then((history: TranscriptEntry[]) => {
                if (history.length > 0) onForkHistoryLoaded(history);
              })
              .catch((err: unknown) => console.error('[ControlPanel] fork history load failed:', err));
          }

          // Apply inherited settings (idempotent)
          if (model) dispatch({ type: 'SET_MODEL', model });
          if (agencyMode) dispatch({ type: 'SET_AGENCY_MODE', mode: agencyMode });
          if (bypassEnabled !== undefined) dispatch({ type: 'SET_BYPASS', enabled: bypassEnabled });
          if (chromeEnabled !== undefined) dispatch({ type: 'SET_CHROME', enabled: chromeEnabled });

          // Prefill input (user sends manually)
          if (initialPrompt) {
            dispatch({ type: 'SET_INPUT', value: initialPrompt });
          }
        }
      }
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [transport, onForkHistoryLoaded]); // transport is module-level stable, onForkHistoryLoaded is a stable useCallback

    // --- Fork execution (shared between control panel button and per-message buttons) ---
    const executeFork = useCallback((atMessageId: string) => {
      if (!selectedSessionId || selectedSessionId.startsWith('pending:')) return;
      const currentInput = state.input.trim();

      transport.forkToNewPanel?.({
        fromSessionId: selectedSessionId,
        atMessageId,
        initialPrompt: currentInput || undefined,
        model: state.model || undefined,
        agencyMode: state.agencyMode,
        bypassEnabled: state.bypassEnabled,
        chromeEnabled: state.chromeEnabled,
      })?.catch((err: Error) => {
        console.error('[ControlPanel] forkToNewPanel failed:', err);
      });

      if (currentInput) dispatch({ type: 'CLEAR_INPUT' });
    }, [selectedSessionId, state.input, state.model, state.agencyMode, state.bypassEnabled, state.chromeEnabled, transport]);

    // Register executeFork with parent for per-message fork buttons
    useEffect(() => { onRegisterForkHandler?.(executeFork); }, [onRegisterForkHandler, executeFork]);

    // --- Rewind execution (fork-in-same-panel): load fork history + set fork mode ---
    const executeRewind = useCallback((atMessageId: string) => {
      if (!selectedSessionId || selectedSessionId.startsWith('pending:')) return;

      // Load truncated source history for immediate display
      transport.loadSession(selectedSessionId, { until: atMessageId })
        .then((history: TranscriptEntry[]) => {
          if (history.length > 0) onForkHistoryLoaded?.(history);
        })
        .catch((err: unknown) => console.error('[ControlPanel] rewind history load failed:', err));

      // Enter fork mode — the existing handleSend fork branch handles the rest
      dispatch({ type: 'SET_FORK_MODE', forkMode: { fromSessionId: selectedSessionId, atMessageId } });
    }, [selectedSessionId, transport, onForkHistoryLoaded]);

    // Register executeRewind with parent for per-message rewind buttons
    useEffect(() => { onRegisterRewindHandler?.(executeRewind); }, [onRegisterRewindHandler, executeRewind]);

    // --- Fork handler (control panel button — computes fork target, then delegates) ---
    const handleFork = useCallback(() => {
      if (!selectedSessionId || selectedSessionId.startsWith('pending:')) return;
      if (!entries || entries.length === 0) return;

      let forkAtMessageId: string | undefined;

      if (channelState === 'streaming') {
        // While streaming: find last assistant before last user
        let lastUserIdx = -1;
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].type === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx > 0) {
          for (let i = lastUserIdx - 1; i >= 0; i--) {
            if (entries[i].type === 'assistant' && entries[i].uuid) {
              forkAtMessageId = entries[i].uuid!; break;
            }
          }
        }
      } else {
        // Not streaming: find last assistant entry with a uuid (simple backward scan)
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].type === 'assistant' && entries[i].uuid) {
            forkAtMessageId = entries[i].uuid!; break;
          }
        }
      }

      if (forkAtMessageId) executeFork(forkAtMessageId);
    }, [selectedSessionId, channelState, entries, executeFork]);

    const handleForkHover = useCallback(
      (hovering: boolean) => {
        onForkHoverChange?.(hovering);
      },
      [onForkHoverChange],
    );

    return (
      <div
        ref={panelRefCallback}
        className="crispy-cp"
        data-agency={state.agencyMode}
      >
        {children ?? (
          <>
            <AttachmentsRow
              images={state.attachedImages}
              onRemove={(id) => dispatch({ type: 'REMOVE_IMAGE', id })}
            />
            <ChatInput
              value={state.input}
              attachedImages={state.attachedImages}
              onInput={(value) => dispatch({ type: 'SET_INPUT', value })}
              onSend={handleSend}
              forkMode={!!state.forkMode}
              onFork={handleFork}
            />
          </>
        )}
        <div className="crispy-cp-controls">
          <BypassToggle
            checked={state.bypassEnabled}
            onChange={(enabled) => dispatch({ type: 'SET_BYPASS', enabled })}
            disabled={togglesDisabled}
          />
          <AgencyModeSelect
            value={state.agencyMode}
            showBypassOption={state.bypassEnabled}
            onChange={(mode) => dispatch({ type: 'SET_AGENCY_MODE', mode })}
          />
          <ModelSelect
            value={state.model}
            onChange={(model) => dispatch({ type: 'SET_MODEL', model })}
          />
          <FileContextToggle
            checked={state.fileContextEnabled}
            label={state.fileContextLabel}
            onChange={(enabled) => dispatch({ type: 'SET_FILE_CONTEXT', enabled })}
          />
          <span className="crispy-cp-right">
            <ContextWidget percent={state.contextPercent} contextUsage={state.contextUsage} />
            <ChromeToggle
              checked={state.chromeEnabled}
              onChange={(enabled) => dispatch({ type: 'SET_CHROME', enabled })}
              disabled={togglesDisabled}
            />
            <SettingsPopup
              pinned={settingsPinned}
              onToggle={() => setSettingsPinned(!settingsPinned)}
              renderMode={renderMode}
              onRenderModeChange={setRenderMode}
            />
            <ForkButton
              disabled={!selectedSessionId || selectedSessionId.startsWith('pending:')}
              onFork={handleFork}
              onHoverChange={handleForkHover}
            />
          </span>
        </div>
      </div>
    );
  },
);
