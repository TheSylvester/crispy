/**
 * Rosie Hook — Auto-extracts quest + summary after each turn
 *
 * Registers as a responseComplete lifecycle handler. On each turn completion,
 * dispatches an ephemeral child session to query a model for structured JSON
 * output, then writes results to the activity index.
 *
 * Uses dispatch.dispatchChild() — the shared child session primitive in
 * session-manager — rather than hand-rolling session lifecycle management.
 *
 * @module rosie-hook
 */

import { onResponseComplete } from '../lifecycle-hooks.js';
import type { AgentDispatch } from '../../host/agent-dispatch.js';
import { getSettingsSnapshotInternal } from '../settings/index.js';
import { parseModelOption } from '../model-utils.js';

// ============================================================================
// Module State
// ============================================================================

let dispatch: AgentDispatch | null = null;
let unsubscribe: (() => void) | null = null;
const inflight = new Set<string>();

// ============================================================================
// Lifecycle
// ============================================================================

export function initRosie(d: AgentDispatch): void {
  dispatch = d;
  unsubscribe = onResponseComplete(async (sessionId: string) => {
    // Capture dispatch locally — shutdownRosie() can set the module-level
    // variable to null while this async handler is in-flight.
    const d = dispatch;
    if (!d) return;

    // Guard: settings check
    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.enabled) return;

    // Guard: pending IDs, inflight
    if (sessionId.startsWith('pending:')) return;
    if (inflight.has(sessionId)) return;

    // Look up session info (child session guard is handled by lifecycle-hooks)
    const info = await d.findSession(sessionId);
    if (!info) return;

    // Resolve model — settings override, else system default
    const rosieModel = snap.settings.rosie.model; // "vendor:model" or undefined

    inflight.add(sessionId);
    try {
      await runRosieAnalysis(d, sessionId, info.path, info.vendor, rosieModel);
    } finally {
      inflight.delete(sessionId);
    }
  });
}

export function shutdownRosie(): void {
  unsubscribe?.();
  unsubscribe = null;
  dispatch = null;
}

// ============================================================================
// Analysis
// ============================================================================

async function runRosieAnalysis(
  d: AgentDispatch,
  sessionId: string, _sessionPath: string, parentVendor: string,
  modelOverride?: string,
): Promise<void> {
  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  try {
    const result = await d.dispatchChild({
      parentSessionId: sessionId,
      vendor,
      parentVendor,
      prompt: ROSIE_PROMPT,
      settings: {
        ...(model && { model }),
      },
      skipPersistSession: true,
      autoClose: true,
      timeoutMs: 30_000,
      maxTurns: 1,
      settingSources: [],
      disableTools: true,
    });

    console.log(`[rosie] ✅ response:`, result ? result.text.slice(0, 500) : 'null');
  } catch (err) {
    console.warn(`[rosie] ❌ threw:`, err);
  }
}

// ============================================================================
// Constants
// ============================================================================

const ROSIE_PROMPT = `What is the Main Quest of this conversation?
Give this conversation a title, maximum 7 words in length.
Would you summarize this last turn what has just happened in one sentence.

Answer like this:
Main Quest: <quest>
Conversation Title: <title>
Turn Summary: <summary>`;
