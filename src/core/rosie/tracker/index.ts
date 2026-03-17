export {
  getExistingProjects,
  getProjectsWithDetails,
  writeTrackerResults,
  recordTrackerOutcome,
  runDedupSweep,
  mergeProjects,
  recordProjectActivity,
  updateProjectStage,
  updateProjectSortOrder,
  reorderProjectsInStage,
  getProjectActivity,
  getStages,
  getStagesForPrompt,
  getValidStageNames,
  getProjectTitle,
  getCompactProjectsForPrompt,
} from './db-writer.js';
export type { StageRow } from './db-writer.js';

export type { InternalServerPaths } from './types.js';
export type {
  TrackerBlock,
  ProjectCreate,
  ProjectTrack,
  ProjectUpsert,
  ProjectStage,
  SessionRef,
  FileRef,
} from './types.js';
export { VALID_STAGES } from './types.js';

export { extractTurns, extractTurnsFromMessages, extractLatestTurn, formatTurnContent } from './turn-extractor.js';
export type { SessionTurn, FlatMessage } from './turn-extractor.js';
