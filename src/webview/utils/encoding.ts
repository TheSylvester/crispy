/**
 * Binary Encoding Utilities — Float32Array ↔ base64 for JSON transport
 *
 * Used by both WebSocket and VS Code transports to serialize audio data.
 *
 * @module utils/encoding
 */

/**
 * Encode a Float32Array as a base64 string for JSON transport.
 *
 * Uses chunked String.fromCharCode to avoid O(n²) string concatenation
 * that occurs with byte-by-byte appending.
 */
export function float32ToBase64(pcmFloat32: Float32Array): string {
  const bytes = new Uint8Array(pcmFloat32.buffer, pcmFloat32.byteOffset, pcmFloat32.byteLength);
  const chunks: string[] = [];
  const CHUNK_SIZE = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}
