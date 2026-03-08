/**
 * Control Panel — floating bottom-center bar with chat input and controls
 *
 * Parent shell that composes all control sub-components. Uses useReducer
 * for coupled cross-field state (bypass ↔ agency mode). Send is wired to
 * transport — submitting the chat input calls transport.sendTurn() with the
 * active session. Other controls remain local/visual-only.
 *
 * Two rows:
 * - Row 1: Auto-resizing textarea + send button + image attachment chips
 * - Row 2: Bypass | Agency | Model | File Context | Context | Chrome | Settings | Fork
 *
 * @module control-panel/ControlPanel
 */

import { useReducer, useEffect, useCallback, useRef, forwardRef, useState, useMemo } from 'react';
import {
  type ControlPanelState,
  type Action,
  type AgencyMode,
  type ModelOption,
  type AttachedImage,
  DEFAULT_CONTROL_PANEL_STATE,
  type VendorModelGroup,
  mapAgencyToPermissionMode,
  mapPermissionModeToAgency,
  parseModelOption,
} from './types.js';
import { ChatInput } from './ChatInput.js';
import { AttachmentsRow } from './AttachmentsRow.js';
import { BypassToggle } from './BypassToggle.js';
import { AgencyModeSelect } from './AgencyModeSelect.js';
import { ModelSelect } from './ModelSelect.js';
import { ContextWidget } from './ContextWidget.js';
import { ChromeToggle } from './ChromeToggle.js';
import { SettingsPopup } from './SettingsPopup.js';
import { RosiePanel } from './RosiePanel.js';
import { ForkButton } from './ForkButton.js';
import { usePreferences } from '../../context/PreferencesContext.js';
import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { slugToPath } from '../../hooks/useSessionCwd.js';
import { useContextUsage } from '../../hooks/useContextUsage.js';
import { useSessionStatus } from '../../hooks/useSessionStatus.js';
import { useRosieLog } from '../../hooks/useRosieLog.js';
import { useVoiceInput } from '../../hooks/useVoiceInput.js';
import { extractFilePathsFromDragEvent, isImageExtension } from '../../utils/drag-drop.js';
import type { MessageContent, MessageContentBlock, TranscriptEntry } from '../../../core/transcript.js';
import type { TurnIntent, TurnTarget } from '../../../core/agent-adapter.js';
import type { WireProviderConfig } from '../../../core/settings/types.js';
import type { SettingsChangedGlobalEvent } from '../../../core/settings/events.js';
import { SETTINGS_CHANNEL_ID } from '../../../core/settings/events.js';

interface ControlPanelProps {
  onForkHoverChange?: (hovering: boolean) => void;
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
  /** Inject a synthetic user entry for immediate rendering before backend echo. */
  onOptimisticEntry?: (entry: TranscriptEntry) => void;
}

/** Agency modes for keyboard cycling (excluding bypass-permissions). */
const CYCLABLE_AGENCY_MODES: AgencyMode[] = [
  'plan-mode',
  'edit-automatically',
  'ask-before-edits',
];

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
  function ControlPanel({ onForkHoverChange, onScrollToBottom, entries, children, onBypassChange, prefillInput, onPrefillConsumed, onForkHistoryLoaded, onRegisterForkHandler, onRegisterRewindHandler, pendingAgencyMode, onPendingAgencyModeConsumed, onOptimisticEntry }, ref) {
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
    const { renderMode, setRenderMode, settingsPinned, setSettingsPinned, toolViewOverride, setToolViewOverride, debugMode, setDebugMode, toolPanelAutoOpen, setToolPanelAutoOpen } = usePreferences();
    const [rosiePanelPinned, setRosiePanelPinned] = useState(false);
    const rosieLogEntries = useRosieLog();
    const transport = useTransport();

    const { selectedSessionId, selectedCwd, setSelectedSessionId, sessions, workspaceCwdPath } = useSession();
    const { channelState, setOptimistic: setOptimisticStatus } = useSessionStatus(selectedSessionId);
    const togglesDisabled = channelState === 'streaming' || channelState === 'awaiting_approval';

    // --- sendTurn error banner ---
    const [sendError, setSendError] = useState<string | null>(null);
    const sendErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const forkTargetRef = useRef<string | undefined>(undefined);

    /** Show a send error with auto-dismiss after 8s. */
    const showSendError = useCallback((msg: string) => {
      setSendError(msg);
      if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
      sendErrorTimerRef.current = setTimeout(() => setSendError(null), 8000);
    }, []);

    /** Clear send error (on next successful send or manual dismiss). */
    const clearSendError = useCallback(() => {
      setSendError(null);
      if (sendErrorTimerRef.current) { clearTimeout(sendErrorTimerRef.current); sendErrorTimerRef.current = null; }
    }, []);

    // --- Voice input ---
    // In VS Code mode, delegate recording + transcription to extension host
    // (Electron denies getUserMedia in webview iframes).
    const hostCapture = useMemo(() => {
      if (!transport.startVoiceCapture || !transport.stopVoiceCapture) return undefined;
      const start = transport.startVoiceCapture.bind(transport);
      const stop = transport.stopVoiceCapture.bind(transport);
      return { start, stop };
    }, [transport]);

    const voice = useVoiceInput({
      transcribe: useCallback((pcm: Float32Array, sr: number) => transport.transcribeAudio(pcm, sr), [transport]),
      onTranscript: useCallback((text: string) => {
        // Append transcribed text to existing input (hybrid input support).
        // Read current value from DOM since useReducer doesn't support functional updates.
        const textarea = document.querySelector<HTMLTextAreaElement>('.crispy-cp-input');
        const current = textarea?.value ?? '';
        const separator = current && !current.endsWith(' ') ? ' ' : '';
        dispatch({ type: 'SET_INPUT', value: current + separator + text });
        textarea?.focus();
      }, []),
      onError: useCallback((error: string) => {
        console.error('[Voice]', error);
        showSendError(`Voice: ${error}`);
      }, [showSendError]),
      hostCapture,
    });

    // --- Compact mode detection via ResizeObserver ---
    // Matches the @container (max-width: 480px) breakpoint in CSS.
    const [compact, setCompact] = useState(false);

    useEffect(() => {
      if (!panelEl) return;
      const ro = new ResizeObserver(([entry]) => {
        setCompact(entry.contentRect.width <= 480);
      });
      ro.observe(panelEl);
      return () => ro.disconnect();
    }, [panelEl]);

    // --- Dynamic model groups from provider-config ---
    const [modelGroups, setModelGroups] = useState<VendorModelGroup[]>([]);

    useEffect(() => {
      transport.getModelGroups().then(setModelGroups).catch(console.error);
    }, [transport]);

    // Listen for push updates when settings.json changes
    useEffect(() => {
      const off = transport.onEvent((sessionId, event) => {
        if (sessionId === SETTINGS_CHANNEL_ID && event.type === 'settings_snapshot') {
          const settingsEvent = event as SettingsChangedGlobalEvent;
          setProviders(settingsEvent.snapshot.settings.providers);
          setRosieEnabled(settingsEvent.snapshot.settings.rosie?.summarize?.enabled ?? false);
          setRosieModel(settingsEvent.snapshot.settings.rosie?.summarize?.model);
          const mcpMem = settingsEvent.snapshot.settings.mcp?.memory;
          if (mcpMem) {
            setMcpMemoryEnabled(mcpMem[mcpSettingsKey] ?? true);
          }
          transport.getModelGroups().then(setModelGroups).catch(console.error);
        }
      });
      return off;
    }, [transport]);

    /** Model options for keyboard cycling — dynamic from provider groups (skip unavailable). */
    const allCyclable = useMemo<ModelOption[]>(() => [
      '',
      ...modelGroups
        .filter(g => g.available !== false)
        .flatMap(g => g.models.map(m => m.value)),
    ], [modelGroups]);

    // --- Provider management state ---
    const [providers, setProviders] = useState<Record<string, WireProviderConfig>>({});

    useEffect(() => {
      transport.listProviders().then(setProviders).catch(console.error);
    }, [transport]);

    // --- Rosie Bot settings state ---
    const [rosieEnabled, setRosieEnabled] = useState(false);
    const [rosieModel, setRosieModel] = useState<string | undefined>(undefined);
    const [trackerEnabled, setTrackerEnabled] = useState(false);

    useEffect(() => {
      transport.getSettings().then((snapshot) => {
        setRosieEnabled(snapshot.settings.rosie?.summarize?.enabled ?? false);
        setRosieModel(snapshot.settings.rosie?.summarize?.model);
        setTrackerEnabled(snapshot.settings.rosie?.tracker?.enabled ?? false);
      }).catch(console.error);
    }, [transport]);

    const handleUpdateRosie = useCallback(async (patch: { enabled?: boolean; model?: string }) => {
      await transport.updateSettings({ rosie: { summarize: patch } });
    }, [transport]);

    const handleUpdateTracker = useCallback(async (enabled: boolean) => {
      setTrackerEnabled(enabled);
      await transport.updateSettings({ rosie: { tracker: { enabled } } });
    }, [transport]);

    // --- MCP Memory settings state ---
    const envKind = useEnvironment();
    const mcpSettingsKey = envKind === 'vscode' ? 'vscode' : 'devServer';
    const [mcpMemoryEnabled, setMcpMemoryEnabled] = useState(true); // default ON

    useEffect(() => {
      transport.getSettings().then((snapshot) => {
        const mcpMem = snapshot.settings.mcp?.memory;
        if (mcpMem) {
          setMcpMemoryEnabled(mcpMem[mcpSettingsKey] ?? true);
        }
      }).catch(console.error);
    }, [transport, mcpSettingsKey]);

    const handleUpdateMcpMemory = useCallback(async (enabled: boolean) => {
      setMcpMemoryEnabled(enabled);
      await transport.updateSettings({ mcp: { memory: { [mcpSettingsKey]: enabled } } });
    }, [transport, mcpSettingsKey]);

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

        // Alt+M: Cycle models (Default → dynamic model groups → back)
        if (e.key === 'm' && e.altKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          const idx = allCyclable.indexOf(state.model);
          const next = allCyclable[(idx + 1) % allCyclable.length];
          dispatch({ type: 'SET_MODEL', model: next });
          return;
        }

        // Ctrl+Shift+Space / Cmd+Shift+Space: Toggle voice input (dev-server fallback)
        // Use e.code (physical key) — e.key is unreliable with input methods.
        if (e.code === 'Space' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
          e.preventDefault();
          console.log('[Voice] keyboard shortcut Ctrl+Shift+Space fired, voice.state:', voice.state);
          voice.toggle();
          return;
        }
      };

      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [state.bypassEnabled, state.agencyMode, state.model, togglesDisabled, allCyclable, voice]);

    // --- Server → UI: settings sync notifications ---
    // Server-initiated setting changes update the local state. Handles both
    // legacy permission_mode_changed (from adapter) and the new settings_changed
    // (broadcast after each sendTurn) for cross-panel sync.
    useEffect(() => {
      const off = transport.onEvent((sessionId, event) => {
        if (sessionId !== selectedSessionId) return;

        /** Apply AdapterSettings to local state (model, agency, bypass, chrome). */
        const applySettings = (settings: { vendor: string; model?: string | undefined; permissionMode?: string | undefined; allowDangerouslySkipPermissions: boolean; extraArgs?: Record<string, string | null> | undefined }) => {
          // Sync model — vendor is now part of AdapterSettings.
          // Preserve '' for Claude default (matches the "Default" option value in ModelSelect).
          // Non-Claude vendors always need the prefix to avoid defaulting to Claude via parseModelOption.
          const rawModel = settings.model ?? '';
          const modelValue: ModelOption = settings.vendor === 'claude' && !rawModel
            ? ''
            : `${settings.vendor}:${rawModel}`;
          dispatch({ type: 'SET_MODEL', model: modelValue });
          // Sync permission mode → agency mode
          if (settings.permissionMode) {
            const agencyMode = mapPermissionModeToAgency(settings.permissionMode);
            if (agencyMode) {
              dispatch({ type: 'SET_AGENCY_MODE', mode: agencyMode });
            }
          }
          // Sync bypass
          dispatch({ type: 'SET_BYPASS', enabled: settings.allowDangerouslySkipPermissions });
          // Sync chrome (extraArgs with 'chrome' key means enabled)
          const chromeEnabled = settings.extraArgs != null && 'chrome' in settings.extraArgs;
          dispatch({ type: 'SET_CHROME', enabled: chromeEnabled });
        };

        // Catchup: initial state sync when subscribing to an existing session
        if (event.type === 'catchup' && event.settings) {
          applySettings(event.settings);
          return;
        }

        if (event.type !== 'event' || event.event.type !== 'notification') return;

        if (event.event.kind === 'permission_mode_changed') {
          const serverMode = mapPermissionModeToAgency(event.event.mode);
          if (serverMode) {
            dispatch({ type: 'SET_AGENCY_MODE', mode: serverMode });
          }
        }

        if (event.event.kind === 'settings_changed') {
          applySettings(event.event.settings);
        }
      });
      return off;
    }, [selectedSessionId, transport]);

    // --- Send handler ---
    const handleSend = useCallback(() => {
      const text = state.input.trim();
      const hasImages = state.attachedImages.length > 0;
      if (!text && !hasImages) return;

      // Build MessageContent: plain string for text-only, block array for multimodal
      let content: MessageContent;
      if (hasImages) {
        const blocks: MessageContentBlock[] = [];
        // Images first — matches Claude Code's content order
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

      // Derive vendor and model from the combined "vendor:model" selection
      const { vendor, model } = parseModelOption(state.model);

      // Bail early if creating a new session without a CWD selected
      if (!state.forkMode && !selectedSessionId && !selectedCwd) {
        console.error('[ControlPanel] Cannot create session: no CWD selected');
        return;
      }

      // Resolve real CWD path from sessions' projectPath (avoids lossy slugToPath).
      // Fallback chain: session projectPath → workspace CWD from host → lossy slugToPath.
      // The workspace CWD fallback is critical for brand-new projects with no prior
      // sessions, where slugToPath would mangle hyphenated folder names.
      const resolvedCwd = (() => {
        if (state.forkMode || selectedSessionId || !selectedCwd) return '';
        const realPath = sessions.find(
          (s) => s.projectSlug === selectedCwd && s.projectPath,
        )?.projectPath;
        return realPath ?? workspaceCwdPath ?? slugToPath(selectedCwd);
      })();

      // Build target — session manager detects vendor switches internally
      let target: TurnTarget;
      if (state.forkMode) {
        target = {
          kind: 'fork',
          vendor,
          fromSessionId: state.forkMode.fromSessionId,
          atMessageId: state.forkMode.atMessageId,
        };
      } else if (!selectedSessionId) {
        target = { kind: 'new', vendor, cwd: resolvedCwd };
      } else {
        // Pass model so session manager can detect vendor switches internally
        target = { kind: 'existing', sessionId: selectedSessionId!, model: state.model };
      }

      // Build TurnIntent with unified routing target
      const intent: TurnIntent = {
        content,
        clientMessageId: crypto.randomUUID(),
        settings: {
          model: model || undefined,
          permissionMode: mapAgencyToPermissionMode(state.agencyMode),
          allowDangerouslySkipPermissions: state.bypassEnabled || undefined,
          extraArgs: state.chromeEnabled ? { chrome: null } : undefined,
        },
        target,
      };

      // Stash forkMode for error recovery before clearing
      const forkModeBackup = state.forkMode;

      // Clear input immediately (optimistic)
      dispatch({ type: 'CLEAR_INPUT' });
      onScrollToBottom?.();
      setOptimisticStatus('streaming');

      // Inject optimistic user entry for immediate rendering.
      // For new/fork sessions, the server-broadcast entry arrives before
      // useTranscript has subscribed to the pending session ID, so we
      // must inject locally. The dedup logic in useTranscript replaces
      // the optimistic entry when the real echo arrives.
      if (onOptimisticEntry) {
        const optimisticEntry: TranscriptEntry = {
          type: 'user',
          uuid: `optimistic-${intent.clientMessageId}`,
          sessionId: selectedSessionId ?? 'pending',
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: typeof content === 'string'
              ? [{ type: 'text', text: content }]
              : content as MessageContentBlock[],
          },
        };
        onOptimisticEntry(optimisticEntry);
      }

      transport.sendTurn(intent)
        .then((receipt) => {
          clearSendError();
          // Update selected session if it changed (new/fork/vendor-switch)
          if (receipt.sessionId !== selectedSessionId) {
            setSelectedSessionId(receipt.sessionId);
          }
        })
        .catch((err) => {
          setOptimisticStatus('idle');
          console.error('[ControlPanel] sendTurn failed:', err);
          // Surface error to user
          const msg = err instanceof Error ? err.message : String(err);
          showSendError(msg);
          // Restore input on error
          dispatch({ type: 'SET_INPUT', value: typeof content === 'string' ? content : text });
          if (forkModeBackup) {
            dispatch({ type: 'SET_FORK_MODE', forkMode: forkModeBackup });
          }
        });
    }, [state.input, state.attachedImages, state.model, state.agencyMode, state.bypassEnabled, state.chromeEnabled, state.forkMode, selectedSessionId, selectedCwd, sessions, setSelectedSessionId, setOptimisticStatus, transport, onScrollToBottom, onOptimisticEntry, showSendError, clearSendError, workspaceCwdPath]);

    // Keep ref in sync so forkConfig auto-send always calls the latest handleSend
    useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

    // --- Drag/drop handlers (native addEventListener, not React props) ---
    //
    // Must use native addEventListener directly on the DOM element, not React's
    // onDragOver/onDrop props. React's event delegation attaches a single listener
    // at the root — the browser requires preventDefault() on the actual dragover
    // target synchronously for the element to be a valid drop zone. In VS Code
    // webviews (Electron iframes), React's indirection can cause the browser to
    // reject the drop silently. Native addEventListener works reliably here.
    //
    // Uses relatedTarget check instead of a
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
        // Uses relatedTarget approach — simpler and more reliable than counters.
        const relatedTarget = e.relatedTarget as Node | null;
        if (!relatedTarget || !panelEl.contains(relatedTarget)) {
          panelEl.classList.remove('drag-over');
        }
      };

      const onDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        panelEl.classList.remove('drag-over');

        // 1. Check for Crispy file panel drag FIRST (before extractFilePathsFromDragEvent)
        //    to prevent double-processing (the drag also sets text/plain).
        const crispyFile = e.dataTransfer?.getData('application/x-crispy-file');
        if (crispyFile) {
          insertAtCursor(crispyFile);
          return;
        }

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

              // Insert text trail placeholder at cursor
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

    // --- Latched fork target — freezes during streaming, updates only when idle ---
    useEffect(() => {
      if (channelState !== 'idle' && channelState !== null) return;
      if (!entries || entries.length === 0) {
        forkTargetRef.current = undefined;
        return;
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === 'assistant' && entries[i].uuid) {
          forkTargetRef.current = entries[i].uuid!;
          return;
        }
      }
      forkTargetRef.current = undefined;
    }, [channelState, entries]);

    const handleFork = useCallback(() => {
      if (!selectedSessionId || selectedSessionId.startsWith('pending:')) return;
      if (forkTargetRef.current) executeFork(forkTargetRef.current);
    }, [selectedSessionId, executeFork]);

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
        {sendError && (
          <div className="crispy-control-panel__error" role="alert">
            <span>{sendError}</span>
            <button className="crispy-control-panel__error-dismiss" onClick={clearSendError} aria-label="Dismiss error">×</button>
          </div>
        )}
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
              voiceState={voice.state}
              onVoiceToggle={voice.toggle}
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
            compact={compact}
          />
          <ModelSelect
            value={state.model}
            onChange={(model) => dispatch({ type: 'SET_MODEL', model })}
            groups={modelGroups}
          />
          <span className="crispy-cp-right">
            <ContextWidget percent={state.contextPercent} contextUsage={state.contextUsage} compact={compact} />
            <RosiePanel
              pinned={rosiePanelPinned}
              onToggle={() => setRosiePanelPinned(!rosiePanelPinned)}
              entries={rosieLogEntries}
            />
            {parseModelOption(state.model).vendor === 'claude' && (
              <ChromeToggle
                checked={state.chromeEnabled}
                onChange={(enabled) => dispatch({ type: 'SET_CHROME', enabled })}
                disabled={togglesDisabled}
              />
            )}
            <SettingsPopup
              pinned={settingsPinned}
              onToggle={() => setSettingsPinned(!settingsPinned)}
              renderMode={renderMode}
              onRenderModeChange={setRenderMode}
              toolViewOverride={toolViewOverride}
              onToolViewOverrideChange={setToolViewOverride}
              debugMode={debugMode}
              onDebugModeChange={setDebugMode}
              toolPanelAutoOpen={toolPanelAutoOpen}
              onToolPanelAutoOpenChange={setToolPanelAutoOpen}
              rosieEnabled={rosieEnabled}
              rosieModel={rosieModel}
              onUpdateRosie={handleUpdateRosie}
              trackerEnabled={trackerEnabled}
              onUpdateTracker={handleUpdateTracker}
              mcpMemoryEnabled={mcpMemoryEnabled}
              onUpdateMcpMemory={handleUpdateMcpMemory}
              modelGroups={modelGroups}
              providers={providers}
              onSaveProvider={async (slug, config) => { await transport.saveProvider(slug, config); }}
              onDeleteProvider={(slug) => transport.deleteProvider(slug).catch(console.error)}
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
