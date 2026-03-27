/**
 * AutocompleteDropdown — generic autocomplete dropdown
 *
 * Reusable dropdown for @-mention, /command, and future autocomplete surfaces.
 * Handles selection, keyboard navigation visuals, scroll-into-view, and ARIA.
 *
 * @module webview/components/control-panel/AutocompleteDropdown
 */

import React, { useEffect, useRef } from 'react';

export interface AutocompleteItem {
  key: string;
  label: React.ReactNode;
  description?: string;
}

interface AutocompleteDropdownProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  emptyMessage?: string;
  className?: string;
}

export function AutocompleteDropdown({
  items,
  selectedIndex,
  onSelect,
  emptyMessage = 'No matches',
  className,
}: AutocompleteDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const selected = container.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div className={`crispy-cp-autocomplete ${className ?? ''}`} role="listbox">
        <div className="crispy-cp-autocomplete__empty">{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div className={`crispy-cp-autocomplete ${className ?? ''}`} role="listbox" ref={listRef}>
      {items.map((item, i) => (
        <div
          key={item.key}
          role="option"
          aria-selected={i === selectedIndex}
          className={`crispy-cp-autocomplete__item${i === selectedIndex ? ' crispy-cp-autocomplete__item--selected' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(i);
          }}
        >
          <span className="crispy-cp-autocomplete__label">{item.label}</span>
          {item.description && (
            <span className="crispy-cp-autocomplete__desc">{item.description}</span>
          )}
        </div>
      ))}
    </div>
  );
}
