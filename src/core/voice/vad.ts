/**
 * VAD — Silero Voice Activity Detection wrapper
 *
 * Detects speech segments in PCM Float32 audio (16kHz mono).
 * Uses onnx-community/silero-vad loaded directly via onnxruntime-node
 * (the model repo has no config.json so AutoModel.from_pretrained won't work).
 *
 * Owns: VAD model lifecycle, speech segment detection.
 *
 * @module voice/vad
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';
import { vadCacheDir } from '../paths.js';
import { importOptionalModule } from './optional-import.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeechSegment {
  /** Start sample index (at 16kHz). */
  start: number;
  /** End sample index (at 16kHz). */
  end: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- onnxruntime-node is optional
let ort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const CHUNK_SIZE = 512;
const SPEECH_THRESHOLD = 0.5;
const SILENCE_THRESHOLD = 0.3;
/** Minimum silence duration (in samples at 16kHz) to end a speech segment. */
const SILENCE_GAP_SAMPLES = 8000; // 500ms at 16kHz

const MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';

// ---------------------------------------------------------------------------
// Internal: model download + cache
// ---------------------------------------------------------------------------

async function downloadModel(): Promise<string> {
  const cacheDir = vadCacheDir();
  const modelPath = join(cacheDir, 'model.onnx');

  if (existsSync(modelPath)) {
    return modelPath;
  }

  mkdirSync(cacheDir, { recursive: true });

  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`Failed to download VAD model: HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(modelPath, buffer);

  log({ source: 'voice', level: 'info', summary: `VAD model downloaded from HuggingFace (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)` });

  return modelPath;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Silero VAD ONNX model. Safe to call multiple times — subsequent
 * calls are no-ops.
 */
export async function initVAD(): Promise<void> {
  if (session) return;

  try {
    ort = await importOptionalModule('onnxruntime-node');
    const modelPath = await downloadModel();
    session = await ort.InferenceSession.create(modelPath);

    log({
      source: 'voice',
      level: 'info',
      summary: `Silero VAD model loaded (inputs: ${session.inputNames.join(', ')}, outputs: ${session.outputNames.join(', ')})`,
    });
  } catch (err) {
    log({ source: 'voice', level: 'error', summary: 'Failed to load Silero VAD model', data: err });
    throw err;
  }
}

/**
 * Detect speech segments in 16kHz mono PCM Float32 audio.
 *
 * Processes audio in 512-sample chunks, applying hysteresis thresholds
 * (start at >0.5, end after <0.3 sustained for 500ms).
 *
 * @returns Array of speech segments as sample-index ranges.
 */
export async function runVAD(audio: Float32Array): Promise<SpeechSegment[]> {
  if (!session) {
    throw new Error('VAD model not initialised — call initVAD() first');
  }

  const segments: SpeechSegment[] = [];
  let inSpeech = false;
  let segmentStart = 0;
  let silenceSamples = 0;

  // Silero VAD internal state: combined h+c tensor [2, 1, 128] and sr tensor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

  const totalChunks = Math.floor(audio.length / CHUNK_SIZE);

  log({
    source: 'voice',
    level: 'info',
    summary: `VAD processing ${audio.length} samples (${(audio.length / SAMPLE_RATE).toFixed(1)}s), ${totalChunks} chunks`,
  });

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = audio.subarray(offset, offset + CHUNK_SIZE);

    const inputTensor = new ort.Tensor('float32', chunk, [1, chunk.length]);

    const feeds: Record<string, unknown> = { input: inputTensor, sr, state };
    const result = await session.run(feeds);

    const prob = (result.output.data as Float32Array)[0];

    // Update hidden state for next chunk.
    state = result.stateN;

    if (!inSpeech) {
      if (prob > SPEECH_THRESHOLD) {
        inSpeech = true;
        segmentStart = offset;
        silenceSamples = 0;
      }
    } else {
      if (prob < SILENCE_THRESHOLD) {
        silenceSamples += CHUNK_SIZE;
        if (silenceSamples >= SILENCE_GAP_SAMPLES) {
          // End segment at the point where silence began.
          segments.push({
            start: segmentStart,
            end: offset - silenceSamples + CHUNK_SIZE,
          });
          inSpeech = false;
          silenceSamples = 0;
        }
      } else {
        silenceSamples = 0;
      }
    }
  }

  // Close any open segment at end of audio.
  if (inSpeech) {
    segments.push({
      start: segmentStart,
      end: totalChunks * CHUNK_SIZE,
    });
  }

  log({
    source: 'voice',
    level: 'info',
    summary: `VAD found ${segments.length} speech segment(s)${segments.length > 0 ? ': ' + segments.map(s => `[${(s.start / SAMPLE_RATE).toFixed(1)}s-${(s.end / SAMPLE_RATE).toFixed(1)}s]`).join(', ') : ''}`,
  });

  return segments;
}
