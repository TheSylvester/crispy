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

import { pushRosieLog } from '../rosie/index.js';
import { importOptionalModule } from './optional-import.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- @huggingface/transformers is optional
let processor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: any = null;

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
 *
 * Also configures @huggingface/transformers WASM proxy setting. This MUST
 * run before from_pretrained() calls — relocated here from voice-engine.ts
 * to keep HF configuration co-located with HF usage.
 */
export async function initSTT(): Promise<void> {
  if (processor && model) return;

  try {
    pushRosieLog({
      source: 'voice',
      level: 'info',
      summary: 'Loading Moonshine Base STT model...',
    });

    const hf = await importOptionalModule<typeof import('@huggingface/transformers')>(
      '@huggingface/transformers',
    );

    // Configure WASM proxy BEFORE loading models (safe for Node).
    if (hf.env?.backends?.onnx?.wasm) {
      hf.env.backends.onnx.wasm.proxy = false;
    }

    const [p, m] = await Promise.all([
      hf.AutoProcessor.from_pretrained(MODEL_ID),
      hf.MoonshineForConditionalGeneration.from_pretrained(MODEL_ID, {
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
