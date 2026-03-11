/**
 * useVoiceInput — Push-to-talk voice capture hook
 *
 * Two capture modes:
 * - **Browser** (dev server): getUserMedia → ScriptProcessorNode → PCM → host transcription
 * - **Host** (VS Code): delegates recording + transcription entirely to extension host,
 *   bypassing Electron's getUserMedia restriction in webview iframes.
 *
 * Click-to-start, click-to-stop interaction model.
 *
 * Owns: MediaStream lifecycle (browser mode), recording state.
 * Does not: run STT (host does that), modify chat input (caller does that).
 *
 * @module hooks/useVoiceInput
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceInputOptions {
  /** RPC call to host: send audio, get text back (browser capture mode) */
  transcribe: (pcmFloat32: Float32Array, sampleRate: number) => Promise<{ text: string }>;
  /** Called when transcription completes with non-empty text */
  onTranscript: (text: string) => void;
  /** Called on errors (mic denied, transcription failed, etc.) */
  onError?: (error: string) => void;
  /**
   * Host-side audio capture (VS Code mode). When provided, recording + transcription
   * are fully delegated to the extension host — getUserMedia is not used.
   */
  hostCapture?: {
    start: () => Promise<void>;
    stop: () => Promise<{ text: string }>;
  };
}

interface UseVoiceInputResult {
  state: VoiceState;
  toggle: () => void;
}

/**
 * Concatenate an array of Float32Arrays into a single contiguous Float32Array.
 */
function concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceState>('idle');

  // Stable ref for options to avoid stale closures in async flows.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ---------- Double-click guard ----------
  const actionInFlightRef = useRef(false);

  // ---------- Browser capture refs (unused in host mode) ----------
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);

  /**
   * Tear down browser audio resources. Safe to call multiple times.
   * No-op in host capture mode (nothing to clean up client-side).
   */
  const teardown = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  // ================================================================
  // Host capture mode (VS Code)
  // ================================================================

  const startHostRecording = useCallback(async () => {
    const hostCapture = optionsRef.current.hostCapture;
    if (!hostCapture) return;

    console.log('[Voice] startHostRecording: delegating to extension host...');
    actionInFlightRef.current = true;
    try {
      await hostCapture.start();
      setState('recording');
      console.log('[Voice] host recording started');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start host recording';
      console.error('[Voice] startHostRecording error:', err);
      optionsRef.current.onError?.(message);
    } finally {
      actionInFlightRef.current = false;
    }
  }, []);

  const stopHostAndTranscribe = useCallback(async () => {
    const hostCapture = optionsRef.current.hostCapture;
    if (!hostCapture) return;

    console.log('[Voice] stopHostAndTranscribe: stopping host capture...');
    setState('transcribing');
    actionInFlightRef.current = true;

    try {
      const { text } = await hostCapture.stop();
      console.log(`[Voice] host transcription result: "${text.slice(0, 100)}"${text.length > 100 ? '...' : ''}`);
      if (text.trim().length > 0) {
        optionsRef.current.onTranscript(text);
      } else {
        console.log('[Voice] empty host transcription, no text appended');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Host transcription failed';
      console.error('[Voice] host transcription error:', err);
      optionsRef.current.onError?.(message);
    } finally {
      actionInFlightRef.current = false;
      setState('idle');
    }
  }, []);

  // ================================================================
  // Browser capture mode (dev server)
  // ================================================================

  /**
   * Start capturing microphone audio at 16 kHz mono via Web Audio API.
   */
  const startBrowserRecording = useCallback(async () => {
    console.log('[Voice] startBrowserRecording: requesting getUserMedia...');
    actionInFlightRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[Voice] getUserMedia granted, tracks:', stream.getAudioTracks().map(t => `${t.label} (${t.readyState})`));

      // Request 16 kHz; the browser may give a different rate — host resamples.
      const audioContext = new AudioContext({ sampleRate: 16000 });
      console.log('[Voice] AudioContext created, sampleRate:', audioContext.sampleRate, 'state:', audioContext.state);

      const source = audioContext.createMediaStreamSource(stream);

      // ScriptProcessorNode is deprecated but universally supported.
      // AudioWorklet requires a separate module file — overkill for this use case.
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const channelData = e.inputBuffer.getChannelData(0);
        // Copy — the underlying buffer is reused by the audio pipeline.
        chunks.push(new Float32Array(channelData));
        if (chunks.length % 50 === 1) {
          console.log(`[Voice] recording chunk #${chunks.length}, buffer size: ${chunks.length * channelData.length} samples`);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      processorRef.current = processor;
      chunksRef.current = chunks;

      setState('recording');
      console.log('[Voice] browser recording started');
    } catch (err: unknown) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone access denied'
          : err instanceof Error
            ? err.message
            : 'Failed to start recording';
      console.error('[Voice] startBrowserRecording error:', err);
      optionsRef.current.onError?.(message);
    } finally {
      actionInFlightRef.current = false;
    }
  }, []);

  /**
   * Stop browser recording, concatenate captured audio, send to host for transcription.
   */
  const stopBrowserAndTranscribe = useCallback(async () => {
    const sampleRate = audioContextRef.current?.sampleRate ?? 16000;
    const chunks = chunksRef.current;

    console.log(`[Voice] stopBrowserAndTranscribe: ${chunks.length} chunks, sampleRate: ${sampleRate}`);
    teardown();

    if (chunks.length === 0) {
      console.log('[Voice] no audio chunks captured, returning to idle');
      setState('idle');
      return;
    }

    const pcm = concatFloat32Arrays(chunks);
    chunksRef.current = [];

    console.log(`[Voice] sending ${pcm.length} samples (${(pcm.length / sampleRate).toFixed(1)}s) to host for transcription...`);
    setState('transcribing');
    actionInFlightRef.current = true;

    try {
      const { text } = await optionsRef.current.transcribe(pcm, sampleRate);
      console.log(`[Voice] transcription result: "${text.slice(0, 100)}"${text.length > 100 ? '...' : ''}`);
      if (text.trim().length > 0) {
        optionsRef.current.onTranscript(text);
      } else {
        console.log('[Voice] empty transcription, no text appended');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      console.error('[Voice] transcription error:', err);
      optionsRef.current.onError?.(message);
    } finally {
      actionInFlightRef.current = false;
      setState('idle');
    }
  }, [teardown]);

  // ================================================================
  // Toggle — dispatches to host or browser mode
  // ================================================================

  const toggle = useCallback(() => {
    if (actionInFlightRef.current) return; // guard against double-click race

    const useHost = !!optionsRef.current.hostCapture;
    console.log(`[Voice] toggle called, current state: ${state}, mode: ${useHost ? 'host' : 'browser'}`);

    if (state === 'idle') {
      if (useHost) {
        startHostRecording();
      } else {
        startBrowserRecording();
      }
    } else if (state === 'recording') {
      if (useHost) {
        stopHostAndTranscribe();
      } else {
        stopBrowserAndTranscribe();
      }
    }
    // 'transcribing' — ignore clicks while processing.
  }, [state, startHostRecording, stopHostAndTranscribe, startBrowserRecording, stopBrowserAndTranscribe]);

  // Cleanup on unmount: stop recording if still active.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  return { state, toggle };
}
