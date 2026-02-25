/**
 * VendorChips — horizontal vendor filter chip bar
 *
 * Renders a row of toggleable vendor chips, each showing the vendor's icon.
 * Multiple chips may be active simultaneously (OR logic). When no chips are
 * active, all vendors are shown (equivalent to "all selected").
 *
 * Only renders when 2+ vendors exist in the session list. If all sessions
 * are from a single vendor, this component renders nothing.
 *
 * @module VendorChips
 */

import { VendorIcon } from './VendorIcon.js';

interface VendorChipsProps {
  availableVendors: string[];
  activeVendors: Set<string>;
  onToggle: (vendor: string) => void;
}

export function VendorChips({
  availableVendors,
  activeVendors,
  onToggle,
}: VendorChipsProps): React.JSX.Element | null {
  if (availableVendors.length < 2) return null;

  return (
    <div className="crispy-vendor-chips">
      {availableVendors.map(vendor => (
        <button
          key={vendor}
          className="crispy-vendor-chip"
          aria-pressed={activeVendors.has(vendor)}
          onClick={() => onToggle(vendor)}
          title={`Filter by ${vendor}`}
        >
          <VendorIcon vendor={vendor} size={12} className="crispy-vendor-chip__icon" />
        </button>
      ))}
    </div>
  );
}
