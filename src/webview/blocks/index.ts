/**
 * Blocks Module — rendering pipeline for blocks mode
 *
 * Public API:
 *
 * Types:
 * - BlockContext, RichBlock, AnchorPoint, ToolViewProps,
 *   ToolDefinition, PanelAction, PanelState
 *
 * Registry:
 * - BlocksToolRegistry: Pairing-only registry for tool_use ↔ tool_result
 *
 * Pipeline:
 * - normalizeToRichBlocks: Enriches TranscriptEntry into RichBlock[]
 * - selectView: Chooses view mode based on anchor point
 *
 * Tool Definitions:
 * - getToolDefinition, getToolData, extractSubject
 * - registerToolViews: Register view implementations
 *
 * Components:
 * - BlocksEntry: Top-level entry renderer
 * - createBlocksToolRegistry: Factory for registry instances
 *
 * @module webview/blocks
 */

// Types
export type {
  BlockContext,
  RichBlock,
  AnchorPoint,
  ToolViewProps,
  ToolDefinition,
  PanelAction,
  PanelState,
} from './types.js';

// Registry
export { BlocksToolRegistry } from './blocks-tool-registry.js';

// Normalization
export { normalizeToRichBlocks } from './normalize.js';

// View Selection
export { selectView } from './select-view.js';

// Tool Definitions
export {
  getToolDefinition,
  getToolData,
  extractSubject,
  registerToolViews,
} from './tool-definitions.js';

// Components
export { BlocksEntry, createBlocksToolRegistry } from './BlocksEntry.js';
export { BlocksEntryWithRegistry } from './BlocksEntryWithRegistry.js';
export { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
export { ToolBlockRenderer } from './ToolBlockRenderer.js';

// Context Providers
export {
  BlocksToolRegistryProvider,
  useBlocksToolRegistry,
  useBlocksChildEntries,
} from './BlocksToolRegistryContext.js';
export {
  BlocksVisibilityProvider,
  useBlocksVisibleToolIds,
  useBlocksToolVisible,
} from './BlocksVisibilityContext.js';

// Panel
export { BlocksToolPanel } from './BlocksToolPanel.js';
export {
  panelReducer,
  initialPanelState,
  isToolExpanded,
} from './panel-reducer.js';
export {
  PanelStateProvider,
  usePanelState,
  usePanelDispatch,
} from './PanelStateContext.js';

// Transcript
export { BlocksTranscriptRenderer } from './BlocksTranscriptRenderer.js';

// Fork Integration
export {
  shouldShowForkButtons,
  isEntryLeader,
  isEntryTrailer,
} from './BlocksForkIntegration.js';

// Views (re-export from views module)
export { defaultToolViews, GenericExpandedView } from './views/default-views.js';
