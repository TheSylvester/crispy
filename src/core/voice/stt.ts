/**
 * STT — Moonshine Base Speech-to-Text wrapper
 *
 * Transcribes PCM Float32 audio (16kHz mono) to text using
 * Moonshine Base ONNX via @huggingface/transformers.
 *
 * Owns: STT model lifecycle, audio-to-text transcription.
 *
 * @module voice/stt
 */

import {
  AutoProcessor,
  MoonshineForConditionalGeneration,
} from '@huggingface/transformers';
import { pushRosieLog } from '../rosie/index.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof MoonshineForConditionalGeneration.from_pretrained>> | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID = 'onnx-community/moonshine-base-ONNX';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Moonshine Base processor and model. Safe to call multiple times —
 * subsequent calls are no-ops.
 */
export async function initSTT(): Promise<void> {
  if (processor && model) return;

  try {
    pushRosieLog({
      source: 'voice',
      level: 'info',
      summary: 'Loading Moonshine Base STT model...',
    });

    const [p, m] = await Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID),
      MoonshineForConditionalGeneration.from_pretrained(MODEL_ID, {
        dtype: 'fp32',
        device: 'cpu',
      }),
    ]);

    processor = p;
    model = m;

    pushRosieLog({
      source: 'voice',
      level: 'info',
      summary: 'Moonshine Base STT model loaded',
    });
  } catch (err) {
    pushRosieLog({
      source: 'voice',
      level: 'error',
      summary: 'Failed to load Moonshine Base STT model',
      data: err,
    });
    throw err;
  }
}

/**
 * Transcribe 16kHz mono PCM Float32 audio to text.
 *
 * @returns The transcribed text (empty string for silence / no speech).
 */
export async function runSTT(audio: Float32Array): Promise<string> {
  if (!processor || !model) {
    throw new Error('STT model not initialised — call initSTT() first');
  }

  try {
    const inputs = await processor(audio);
    const output = await model.generate({ ...inputs, max_new_tokens: 500 });
    const text: string = processor.batch_decode(output as any, {
      skip_special_tokens: true,
    })[0];

    return text.trim();
  } catch (err) {
    pushRosieLog({
      source: 'voice',
      level: 'error',
      summary: 'STT transcription failed',
      data: err,
    });
    throw err;
  }
}
