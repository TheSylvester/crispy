/**
 * YAML Entry Renderer — full-entry YAML dump for data inspection
 *
 * Renders the entire TranscriptEntry object as indented YAML with colored
 * keys. Uses the shared YamlDump component (extracted for reuse by
 * BlockRenderer and other renderers).
 *
 * @module webview/renderers/YamlEntry
 */

import type { TranscriptEntry } from '../../core/transcript.js';
import { YamlDump } from './YamlDump.js';

// ============================================================================
// YAML Entry Wrapper
// ============================================================================

interface YamlEntryProps {
  entry: TranscriptEntry;
}

/**
 * Renders a transcript entry as a YAML-like structured dump.
 * Shows the complete entry object for debugging and data inspection.
 */
export function YamlEntry({ entry }: YamlEntryProps): React.JSX.Element {
  const role = entry.message?.role ?? entry.type;

  return (
    <div className={`message ${role} yaml-entry`} data-uuid={entry.uuid}>
      <pre className="yaml-dump">
        <YamlDump value={entry} />
      </pre>
    </div>
  );
}
