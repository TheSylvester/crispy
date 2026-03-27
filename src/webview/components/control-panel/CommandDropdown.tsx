/**
 * CommandDropdown — skill/command autocomplete dropdown
 *
 * Maps InputCommand[] to AutocompleteItem[] with two-column layout
 * (name + description).
 *
 * @module webview/components/control-panel/CommandDropdown
 */

import React from 'react';
import { AutocompleteDropdown, type AutocompleteItem } from './AutocompleteDropdown.js';
import type { InputCommand } from '../../transport.js';

interface CommandDropdownProps {
  commands: InputCommand[];
  selectedIndex: number;
  query: string;
  onSelect: (index: number) => void;
}

export function CommandDropdown({ commands, selectedIndex, query, onSelect }: CommandDropdownProps) {
  const items: AutocompleteItem[] = commands.map(cmd => ({
    key: cmd.id,
    label: <span>{cmd.trigger}{cmd.id}</span>,
    description: cmd.description,
  }));

  return (
    <AutocompleteDropdown
      items={items}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      emptyMessage={query ? 'No matching commands' : 'No commands available'}
    />
  );
}
