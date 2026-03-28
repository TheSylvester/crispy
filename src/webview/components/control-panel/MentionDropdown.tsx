/**
 * Mention Dropdown — filtered file list for @-mention autocomplete
 *
 * Thin wrapper over AutocompleteDropdown that maps FileMatch[] to
 * AutocompleteItem[] and applies query-substring highlighting.
 *
 * @module control-panel/MentionDropdown
 */

import type { FileMatch } from '../../utils/file-index.js';
import { AutocompleteDropdown, type AutocompleteItem } from './AutocompleteDropdown.js';

interface MentionDropdownProps {
  results: FileMatch[];
  selectedIndex: number;
  query: string;
  onSelect: (index: number) => void;
}

/**
 * Highlight matching query substring within a path.
 *
 * Uses the lowercased string's match length (not the query's) for slicing,
 * so characters whose lowercase form differs in length (e.g. ß→ss, İ→i̇)
 * don't misalign the highlight boundaries.
 */
function highlightMatch(path: string, query: string): React.ReactNode {
  if (!query) return path;

  const lowerPath = path.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerPath.indexOf(lowerQuery);

  if (idx === -1) return path;

  // Use lowerQuery.length (matched in lowered space) to slice the original
  const matchLen = lowerQuery.length;
  return (
    <>
      {path.slice(0, idx)}
      <mark className="crispy-cp-autocomplete__highlight">{path.slice(idx, idx + matchLen)}</mark>
      {path.slice(idx + matchLen)}
    </>
  );
}

export function MentionDropdown({
  results,
  selectedIndex,
  query,
  onSelect,
}: MentionDropdownProps): React.JSX.Element {
  const items: AutocompleteItem[] = results.map((m) => ({
    key: m.relativePath,
    label: highlightMatch(m.relativePath, query),
  }));

  return (
    <AutocompleteDropdown
      items={items}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      emptyMessage="No matching files"
    />
  );
}
