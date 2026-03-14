export {
  getExistingProjects,
  getProjectsWithDetails,
  writeTrackerResults,
  recordTrackerOutcome,
  runDedupSweep,
  recordProjectActivity,
  updateProjectStage,
  updateProjectSortOrder,
  reorderProjectsInStage,
  getProjectActivity,
} from './db-writer.js';

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
