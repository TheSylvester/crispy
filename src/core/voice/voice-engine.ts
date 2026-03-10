/**
 * Voice Engine — Lazy-loading Silero VAD + Moonshine Base STT pipeline
 *
 * Accepts raw PCM Float32 audio, gates through VAD to detect speech segments,
 * then transcribes speech segments with Moonshine Base. Models are lazy-downloaded
 * on first invocation and cached locally by @huggingface/transformers.
 *
 * Owns: model lifecycle, VAD->STT pipeline orchestration.
 * Does not: capture audio, manage UI state, touch ~/.crispy/.
 *
 * Platform: requires onnxruntime-node native binaries, which need GLIBC ≥ 2.33.
 * Snap-packaged VS Code bundles GLIBC 2.31 (core20) and will fail — use the
 * .deb install instead (`apt install code`). The dev server is unaffected.
 *
 * @module voice/voice-engine
 */

// @huggingface/transformers and voice sub-modules are lazy-loaded to avoid
// pulling onnxruntime-node native bindings at import time (crashes VS Code's
// Electron extension host). See ensureModels().
import { pushRosieLog } from '../rosie/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscribeResult {
  /** Transcribed text (empty string when no speech detected). */
  text: string;
  /** Number of speech segments detected by VAD. */
  segments: number;
  /** Total processing time in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Cached readiness indicator — true once both models are loaded. */
let pipeline: { ready: true } | null = null;

/** Deduplication guard so concurrent callers share a single load. */
let loading: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Audio normalization
// ---------------------------------------------------------------------------

/**
 * Target RMS amplitude for pre-VAD normalization. 0.1 puts typical speech
 * comfortably above Silero's 0.5 speech-probability threshold without
 * risk of clipping.
 */
const TARGET_RMS = 0.1;

/**
 * Maximum gain multiplier (~20 dB). Prevents amplifying the noise floor
 * into false VAD triggers on near-silent recordings.
 */
const MAX_GAIN = 10;

/**
 * Target peak amplitude for speech segments fed to STT. Moonshine Base
 * was trained on well-leveled audio — normalizing to 0.9 peak keeps
 * the signal in the model's sweet spot while leaving headroom.
 */
const TARGET_PEAK = 0.9;

/**
 * RMS-based normalization — scales the entire buffer so its RMS matches
 * `targetRMS`. This makes VAD thresholds behave consistently regardless
 * of mic gain / OS input volume.
 *
 * Returns the input unchanged when the signal is effectively silent
 * (RMS < 1e-6) to avoid amplifying the noise floor.
 */
function normalizeRMS(
  audio: Float32Array,
  targetRMS = TARGET_RMS,
): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i];
  const rms = Math.sqrt(sumSq / audio.length);

  if (rms < 1e-6) return audio; // silence — don't amplify noise floor

  const gain = Math.min(targetRMS / rms, MAX_GAIN);

  // gain ≈ 1 → skip allocation
  if (Math.abs(gain - 1) < 0.01) return audio;

  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    out[i] = Math.max(-1, Math.min(1, audio[i] * gain));
  }
  return out;
}

/**
 * Peak normalization — scales a buffer so its peak amplitude matches
 * `targetPeak`. Used on extracted speech segments before STT so Moonshine
 * always sees well-leveled input.
 */
function normalizePeak(
  audio: Float32Array,
  targetPeak = TARGET_PEAK,
): Float32Array {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const abs = Math.abs(audio[i]);
    if (abs > peak) peak = abs;
  }

  if (peak < 1e-6) return audio; // silence

  const gain = Math.min(targetPeak / peak, MAX_GAIN);

  if (Math.abs(gain - 1) < 0.01) return audio;

  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    out[i] = Math.max(-1, Math.min(1, audio[i] * gain));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Cached lazy-imported sub-modules. */
let voiceModules: { initVAD: typeof import('./vad.js').initVAD; runVAD: typeof import('./vad.js').runVAD; initSTT: typeof import('./stt.js').initSTT; runSTT: typeof import('./stt.js').runSTT } | null = null;

/**
 * Lazy-load both VAD and STT models. Concurrent calls coalesce into one
 * promise so models are only downloaded once.
 *
 * Also lazy-imports voice sub-modules and configures @huggingface/transformers
 * on first call — this avoids loading onnxruntime-node native bindings at
 * extension activation time.
 */
async function ensureModels(): Promise<void> {
  if (pipeline) return;

  if (!loading) {
    loading = (async () => {
      try {
        pushRosieLog({
          source: 'voice',
          level: 'info',
          summary: 'Initialising voice pipeline (VAD + STT)...',
        });

        // Configure @huggingface/transformers WASM proxy (safe for Node).
        const { env } = await import('@huggingface/transformers');
        if (env.backends.onnx.wasm) {
          env.backends.onnx.wasm.proxy = false;
        }

        // Lazy-import sub-modules (pulls onnxruntime-node).
        const [vadMod, sttMod] = await Promise.all([
          import('./vad.js'),
          import('./stt.js'),
        ]);
        voiceModules = {
          initVAD: vadMod.initVAD,
          runVAD: vadMod.runVAD,
          initSTT: sttMod.initSTT,
          runSTT: sttMod.runSTT,
        };

        await Promise.all([voiceModules.initVAD(), voiceModules.initSTT()]);

        pipeline = { ready: true };

        pushRosieLog({
          source: 'voice',
          level: 'info',
          summary: 'Voice pipeline ready',
        });
      } catch (err) {
        // Reset so a subsequent call can retry.
        loading = null;

        const msg = err instanceof Error ? err.message : String(err);
        const isGlibc = msg.includes('GLIBC');
        pushRosieLog({
          source: 'voice',
          level: 'error',
          summary: isGlibc
            ? 'Voice requires GLIBC ≥ 2.33. Snap-packaged VS Code ships GLIBC 2.31 — install VS Code via .deb instead (apt install code).'
            : 'Voice pipeline initialisation failed',
          data: err,
        });
        throw err;
      }
    })();
  }

  await loading;
}

/**
 * Resample audio from `srcRate` to `TARGET_SAMPLE_RATE` using simple linear
 * interpolation. Returns the input unchanged if rates already match.
 */
function resampleTo16kHz(
  audio: Float32Array,
  srcRate: number,
): Float32Array {
  if (srcRate === TARGET_SAMPLE_RATE) return audio;

  const ratio = srcRate / TARGET_SAMPLE_RATE;
  const outLength = Math.round(audio.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const lo = Math.floor(srcIndex);
    const hi = Math.min(lo + 1, audio.length - 1);
    const frac = srcIndex - lo;
    out[i] = audio[lo] * (1 - frac) + audio[hi] * frac;
  }

  return out;
}

/**
 * Concatenate multiple Float32Arrays into a single contiguous buffer.
 */
function concatFloat32(arrays: Float32Array[]): Float32Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;

  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full voice-to-text pipeline: resample -> VAD -> STT.
 *
 * Models are lazy-downloaded on first call and cached by
 * `@huggingface/transformers` in the default HF cache directory.
 *
 * @param pcmFloat32  Raw PCM audio as Float32Array (values in -1..1).
 * @param sampleRate  Sample rate of the input audio.
 * @returns Transcription result with text, segment count, and timing.
 */
export async function transcribeAudio(
  pcmFloat32: Float32Array,
  sampleRate: number,
): Promise<TranscribeResult> {
  const t0 = performance.now();

  try {
    await ensureModels();

    // 1. Resample to 16kHz if needed.
    const resampled = resampleTo16kHz(pcmFloat32, sampleRate);

    // 2. RMS-normalize so VAD thresholds behave consistently regardless
    //    of mic gain / OS input volume.
    const audio = normalizeRMS(resampled);

    // voiceModules is guaranteed non-null after ensureModels().
    const { runVAD, runSTT } = voiceModules!;

    // 3. Run VAD to detect speech segments.
    const speechSegments = await runVAD(audio);

    if (speechSegments.length === 0) {
      const durationMs = Math.round(performance.now() - t0);
      pushRosieLog({
        source: 'voice',
        level: 'info',
        summary: `No speech detected (${durationMs}ms)`,
      });
      return { text: '', segments: 0, durationMs };
    }

    // 4. Extract and concatenate speech segments.
    const speechChunks = speechSegments.map((seg) =>
      audio.slice(seg.start, seg.end),
    );
    const speechAudio = concatFloat32(speechChunks);

    // 5. Peak-normalize speech so Moonshine sees well-leveled input.
    const normalizedSpeech = normalizePeak(speechAudio);

    // 6. Transcribe normalized speech.
    const text = await runSTT(normalizedSpeech);

    const durationMs = Math.round(performance.now() - t0);

    pushRosieLog({
      source: 'voice',
      level: 'info',
      summary: `Transcribed ${speechSegments.length} segment(s) in ${durationMs}ms: "${text.slice(0, 80)}"`,
    });

    return { text, segments: speechSegments.length, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    pushRosieLog({
      source: 'voice',
      level: 'error',
      summary: 'transcribeAudio failed',
      data: err,
    });
    throw err;
  }
}
