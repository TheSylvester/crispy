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

export const VALID_STATUSES = ['active', 'done', 'blocked', 'planned', 'abandoned'] as const;
export type ProjectStatus = (typeof VALID_STATUSES)[number];

// ============================================================================
// Parsed Output Types
// ============================================================================

export interface ProjectUpsert {
  action: 'upsert';
  id: string;           // empty string = new project, non-empty = existing
  title: string;
  status: ProjectStatus;
  blocked_by: string;
  summary: string;
  branch: string;
  entities: string;     // JSON array string
}

export interface SessionRef {
  detected_in: string;  // message UUID
}

export interface FileRef {
  path: string;         // relative to project root
  note: string;
}

export interface TrackerBlock {
  project: ProjectUpsert;
  sessionRef: SessionRef;
  files: FileRef[];
}

