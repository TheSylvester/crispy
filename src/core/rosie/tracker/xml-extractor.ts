/**
 * Rosie Tracker XML Extractor — Parse tracker LLM response into TrackerBlocks
 *
 * Uses regex extraction via shared xml-utils. Extracts each <tracker> block,
 * then inner tags. Returns empty array on completely unparseable input
 * (never throws).
 *
 * @module rosie/tracker/xml-extractor
 */

import type { TrackerBlock, ProjectUpsert, SessionRef, FileRef, ProjectStatus } from './types.js';
import { extractTag, normalizeEntitiesJson } from '../xml-utils.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse the tracker hook's XML response into structured TrackerBlocks.
 *
 * Expects one or more <tracker>...</tracker> blocks, each containing:
 *   <project action="upsert" id="...">...</project>
 *   <session detected_in="..." />
 *   <file path="..." note="..." />
 *
 * Returns empty array if no valid blocks found.
 */
export function parseTrackerResponse(text: string): TrackerBlock[] {
  const blocks: TrackerBlock[] = [];

  // Extract all <tracker>...</tracker> blocks
  const trackerRegex = /<tracker>([\s\S]*?)<\/tracker>/g;
  let trackerMatch: RegExpExecArray | null;

  while ((trackerMatch = trackerRegex.exec(text)) !== null) {
    const blockText = trackerMatch[1];
    const block = parseTrackerBlock(blockText);
    if (block) blocks.push(block);
  }

  return blocks;
}

// ============================================================================
// Internal Parsing
// ============================================================================

function parseTrackerBlock(text: string): TrackerBlock | null {
  const project = parseProject(text);
  if (!project) return null;

  const sessionRef = parseSessionRef(text);
  const files = parseFiles(text);

  return { project, sessionRef, files };
}

function parseProject(text: string): ProjectUpsert | null {
  // Match <project action="upsert" id="...">...</project>
  // Try both attribute orderings for robustness
  const projectMatch = text.match(
    /<project\s+action="upsert"\s+id="([^"]*)">([\s\S]*?)<\/project>/,
  );
  const altMatch = !projectMatch
    ? text.match(/<project\s+id="([^"]*)"\s+action="upsert">([\s\S]*?)<\/project>/)
    : null;

  const match = projectMatch ?? altMatch;
  if (!match) return null;

  const id = match[1].trim();
  const inner = match[2];

  const title = extractTag(inner, 'title');
  const status = extractTag(inner, 'status') as ProjectStatus;
  const blocked_by = extractTag(inner, 'blocked_by');
  const summary = extractTag(inner, 'summary');
  const category = extractTag(inner, 'category');
  const branch = extractTag(inner, 'branch');
  const entities = normalizeEntitiesJson(extractTag(inner, 'entities'));

  if (!title || !status) return null;

  return {
    action: 'upsert',
    id,
    title,
    status,
    blocked_by,
    summary,
    category,
    branch,
    entities,
  };
}

function parseSessionRef(text: string): SessionRef {
  // <session detected_in="msg-uuid-123" />
  const match = text.match(/<session\s+detected_in="([^"]*)"[^/]*\/>/);
  return { detected_in: match?.[1]?.trim() ?? '' };
}

function parseFiles(text: string): FileRef[] {
  const files: FileRef[] = [];
  // Try both attribute orderings: path+note and note+path
  const fileRegex = /<file\s+(?:path="([^"]*)"\s+note="([^"]*)"|note="([^"]*)"\s+path="([^"]*)")\s*\/>/g;
  let fileMatch: RegExpExecArray | null;

  while ((fileMatch = fileRegex.exec(text)) !== null) {
    const path = (fileMatch[1] ?? fileMatch[4] ?? '').trim();
    const note = (fileMatch[2] ?? fileMatch[3] ?? '').trim();
    if (path) files.push({ path, note });
  }

  return files;
}
