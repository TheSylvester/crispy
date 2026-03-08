/**
 * Voice Module — Public API for voice-to-text pipeline
 *
 * Re-exports the transcription interface from the voice engine.
 *
 * @module voice
 */

export { transcribeAudio, type TranscribeResult } from './voice-engine.js';
