/**
 * Mention Dropdown — filtered file list for @-mention autocomplete
 *
 * Presentational component positioned above the chat input.
 * Uses onMouseDown (not onClick) so selection fires before textarea blur.
 *
 * @module control-panel/MentionDropdown
 */

import { useRef, useEffect } from 'react';
import type { FileMatch } from '../../utils/file-index.js';

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
      <mark className="crispy-cp-mention__highlight">{path.slice(idx, idx + matchLen)}</mark>
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
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (results.length === 0) {
    return (
      <div className="crispy-cp-mention">
        <div className="crispy-cp-mention__empty">No matches</div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="crispy-cp-mention"
    >
      {results.map((file, i) => (
        <div
          key={file.relativePath}
          ref={i === selectedIndex ? selectedRef : undefined}
          className={`crispy-cp-mention__item${i === selectedIndex ? ' crispy-cp-mention__item--selected' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent textarea blur
            onSelect(i);
          }}
        >
          {highlightMatch(file.relativePath, query)}
        </div>
      ))}
    </div>
  );
}
