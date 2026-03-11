/**
 * Optional Import — Centralized optional module loader for voice dependencies
 *
 * Detects MODULE_NOT_FOUND errors and throws a typed VoiceUnavailableError
 * with an actionable message. Keeps detection logic in one place instead of
 * repeating it in vad.ts and stt.ts.
 *
 * Owns: optional dependency detection, VoiceUnavailableError type.
 *
 * @module voice/optional-import
 */

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class VoiceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VoiceUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an error indicates a missing module. Handles both Node's
 * native MODULE_NOT_FOUND and bundler-specific variants.
 */
function isMissingModule(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
    return true;
  }
  // Some bundlers surface the specifier in the message without a code
  if (error.message.includes('Cannot find module') && error.message.includes(specifier)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dynamically import an optional module. If the module is not installed,
 * throws a `VoiceUnavailableError` with an actionable message instead of
 * a raw MODULE_NOT_FOUND error.
 *
 * Non-missing-module errors (e.g. syntax errors in the module) are re-thrown
 * as-is.
 */
export async function importOptionalModule<T = unknown>(
  specifier: string,
): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    if (isMissingModule(error, specifier)) {
      throw new VoiceUnavailableError(
        `Voice is unavailable because optional dependency "${specifier}" is not installed. ` +
        `Install it with: npm install ${specifier}`,
        { cause: error },
      );
    }
    throw error;
  }
}
