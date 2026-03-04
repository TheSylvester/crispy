/**
 * Rosie Hook — Auto-extracts quest + summary after each turn
 *
 * Registers as a responseComplete lifecycle handler. On each turn completion,
 * dispatches an ephemeral child session to query a model for plain-text
 * output, then parses the response and writes results to the activity index.
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
import { appendActivityEntries } from '../activity-index.js';
import { refreshAndNotify } from '../session-list-manager.js';

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
// Response Parsing
// ============================================================================

/**
 * Parse Rosie's XML-tagged response into structured fields.
 *
 * Expects tags:
 *   <goal>...</goal>
 *   <title>...</title>
 *   <summary>...</summary>
 *
 * Uses regex extraction — tags can appear anywhere in the response.
 * Returns null if goal or summary is missing.
 */
function parseRosieResponse(text: string): { quest: string; title: string; summary: string } | null {
  const quest = text.match(/<goal>([\s\S]*?)<\/goal>/)?.[1]?.trim() ?? '';
  const title = text.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? '';

  if (quest && summary) return { quest, title, summary };
  return null;
}

// ============================================================================
// Analysis
// ============================================================================

const MAX_ATTEMPTS = 2;

async function runRosieAnalysis(
  d: AgentDispatch,
  sessionId: string, sessionPath: string, parentVendor: string,
  modelOverride?: string,
): Promise<void> {
  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      });

      if (!result) {
        console.warn(`[rosie] FAIL attempt ${attempt}/${MAX_ATTEMPTS}: dispatchChild returned null`);
        continue;
      }

      console.log(`[rosie] OK response:`, result.text.slice(0, 500));

      const fields = parseRosieResponse(result.text);
      if (!fields) {
        console.warn(`[rosie] FAIL parse: could not extract quest/summary from response: ${result.text.slice(0, 300)}`);
        continue;
      }

      // Write to activity index
      appendActivityEntries([{
        timestamp: new Date().toISOString(),
        kind: 'rosie-meta',
        file: sessionPath,
        preview: fields.quest,
        offset: 0,
        quest: fields.quest,
        summary: fields.summary,
        title: fields.title,
      }]);

      // Push updated metadata to all UI subscribers
      refreshAndNotify(sessionId);
      return;
    } catch (err) {
      console.warn(`[rosie] FAIL attempt ${attempt}/${MAX_ATTEMPTS} threw:`, err);
    }
  }
}

// ============================================================================
// Constants
// ============================================================================

const ROSIE_PROMPT = `Consider this entire conversation so far.
What is the stated or apparent goal of this particular conversation?
How would you label this conversation in a short sentence for a user to best remember what this session was for?
Summarize the last turn: Describe the User Request and your Response; including any work completed

Provide your output in this format:
<goal>The goal of this conversation</goal>
<title>Label the conversation</title>
<summary>Turn summary</summary>`;
