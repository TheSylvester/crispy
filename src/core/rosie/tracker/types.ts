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

export const VALID_CATEGORIES = ['recall', 'ui', 'infra', 'research', 'meta'] as const;

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
  category: string;
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

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: TrackerBlock[];
  errors: string[];
}
