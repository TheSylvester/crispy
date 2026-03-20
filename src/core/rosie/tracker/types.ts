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

/** @deprecated Use getValidStageNames() from db-writer.ts — stages now live in the DB. */
export const VALID_STAGES = ['active', 'planning', 'ready', 'paused', 'archived', 'idea', 'done'] as const;
/** Widened to string — stages are now user-configurable via the DB. */
export type ProjectStage = string;

export const VALID_TYPES = ['project', 'task', 'idea'] as const;
export type ProjectType = (typeof VALID_TYPES)[number];


// ============================================================================
// Parsed Output Types
// ============================================================================

export interface ProjectCreate {
  action: 'create';
  id?: string;           // optional: caller-supplied UUID (generated if omitted)
  title: string;
  stage: ProjectStage;
  status: string;        // freeform narrative
  icon: string;          // emoji
  blocked_by: string;
  summary: string;
  branch: string;
  type?: ProjectType;    // defaults to 'project'
  parent_id?: string;    // required when type === 'task'
}

export interface ProjectTrack {
  action: 'track';
  id: string;            // required: existing project UUID
  status?: string;       // only if changed
  stage?: ProjectStage;  // only if changed
  blocked_by?: string;
  branch?: string;
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
// InternalServerPaths removed — internal MCP server replaced by plugin bundle.
