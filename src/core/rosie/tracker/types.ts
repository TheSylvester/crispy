/**
 * Rosie Tracker Types — Shared type definitions for the project tracker
 *
 * Defines the structured output format parsed from the tracker LLM response,
 * validation result shape, and allowed enum values.
 *
 * @module rosie/tracker/types
 */

// ============================================================================
// Enums
// ============================================================================

export const VALID_STAGES = ['active', 'planning', 'ready', 'committed', 'paused', 'archived'] as const;
export type ProjectStage = (typeof VALID_STAGES)[number];


// ============================================================================
// Parsed Output Types
// ============================================================================

export interface ProjectCreate {
  action: 'create';
  title: string;
  stage: ProjectStage;
  status: string;        // freeform narrative
  icon: string;          // emoji
  blocked_by: string;
  summary: string;
  branch: string;
  entities: string;      // JSON array string
}

export interface ProjectTrack {
  action: 'track';
  id: string;            // required: existing project UUID
  status?: string;       // only if changed
  stage?: ProjectStage;  // only if changed
  blocked_by?: string;
  branch?: string;
  entities?: string;     // additive merge, JSON array string
}

/** @deprecated Use ProjectCreate | ProjectTrack instead. */
export type ProjectUpsert = ProjectCreate | ProjectTrack;

export interface SessionRef {
  detected_in: string;  // message UUID
}

export interface FileRef {
  path: string;         // relative to project root
  note: string;
}

export interface TrackerBlock {
  project: ProjectCreate | ProjectTrack;
  sessionRef: SessionRef;
  files: FileRef[];
}

// ============================================================================
// Shared Types
// ============================================================================

/** Paths for spawning the internal MCP server subprocess. */
export interface InternalServerPaths {
  command: string;
  args: string[];
}

