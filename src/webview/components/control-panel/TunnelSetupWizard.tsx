/**
 * Tunnel Setup Wizard — Cloud Relay pairing and management UI
 *
 * Models on DiscordSetupWizard.tsx. Shows a compact summary when paired,
 * or a pairing form when unconfigured. Host-flag toggles filter by environment.
 *
 * @module control-panel/TunnelSetupWizard
 */

import { useState, useCallback } from 'react';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import type { TunnelSettings } from '../../../core/settings/types.js';
import type { TunnelStatusInfo } from '../../../host/tunnel-client.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface TunnelSetupWizardProps {
  enabled: boolean;
  relayUrl: string;
  tunnelId: string;
  tunnelName: string;
  tunnelStatus: TunnelStatusInfo;
  enableInDevServer: boolean;
  enableInDaemon: boolean;
  enableInTauri: boolean;
  enableInVscode: boolean;
  onUpdateTunnel: (patch: Partial<TunnelSettings>) => void;
  onPair: (relayUrl: string, pairingToken: string, tunnelName: string) => void;
  onUnpair: () => void;
}

const DEFAULT_RELAY_URL = 'https://crispy-code.com';

function statusLabel(info: TunnelStatusInfo): { text: string; className: string } {
  if (info.status === 'connected') {
    return { text: 'Connected', className: 'crispy-tunnel-wizard__status--ok' };
  }
  if (info.status === 'reconnecting') {
    return { text: 'Reconnecting...', className: 'crispy-tunnel-wizard__status--pending' };
  }
  // disconnected — check reason
  switch (info.reason) {
    case 'relay-unreachable':
      return { text: 'Cannot reach relay', className: 'crispy-tunnel-wizard__status--err' };
    case 'invalid-token':
      return { text: 'Token rejected', className: 'crispy-tunnel-wizard__status--err' };
    case 'tunnel-in-use':
      return { text: 'Active elsewhere', className: 'crispy-tunnel-wizard__status--err' };
    default:
      return { text: 'Disconnected', className: 'crispy-tunnel-wizard__status--off' };
  }
}

export function TunnelSetupWizard({
  enabled,
  relayUrl,
  tunnelId,
  tunnelName,
  tunnelStatus,
  enableInDevServer,
  enableInDaemon,
  enableInTauri,
  enableInVscode,
  onUpdateTunnel,
  onPair,
  onUnpair,
}: TunnelSetupWizardProps) {
  const environment = useEnvironment();

  // Draft state for pairing form
  const [draftRelayUrl, setDraftRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [draftToken, setDraftToken] = useState('');
  const [draftName, setDraftName] = useState('');

  // Editing state for paired mode
  const [editing, setEditing] = useState(false);

  const isPaired = enabled && !!tunnelId;

  // Per-host toggle: show only the flag(s) relevant to this host type
  const hostToggles = environment === 'vscode'
    ? [{ label: 'Enable in VS Code', field: 'enableInVscode' as const, value: enableInVscode }]
    : environment === 'tauri'
    ? [{ label: 'Enable in Desktop', field: 'enableInTauri' as const, value: enableInTauri }]
    : [
      { label: 'Enable in Dev Server', field: 'enableInDevServer' as const, value: enableInDevServer },
      { label: 'Enable in Desktop (Tauri)', field: 'enableInTauri' as const, value: enableInTauri },
      { label: 'Enable in Daemon', field: 'enableInDaemon' as const, value: enableInDaemon },
      { label: 'Enable in VS Code', field: 'enableInVscode' as const, value: enableInVscode },
    ];

  const hostToggleElements = hostToggles.map((t) => (
    <label key={t.field} className="crispy-cp-settings__row">
      <span>{t.label}</span>
      <input
        type="checkbox"
        checked={t.value}
        onChange={(e) => onUpdateTunnel({ [t.field]: e.target.checked })}
      />
    </label>
  ));

  const handlePair = useCallback(() => {
    if (!draftToken.trim() || !draftRelayUrl.trim()) return;
    onPair(draftRelayUrl.trim(), draftToken.trim(), draftName.trim() || '');
    setDraftToken('');
    setDraftName('');
  }, [draftRelayUrl, draftToken, draftName, onPair]);

  const handleUnpair = useCallback(() => {
    onUnpair();
    setEditing(false);
  }, [onUnpair]);

  // --- Unpaired state: show pairing form ---
  if (!isPaired) {
    return (
      <div className="crispy-tunnel-wizard">
        <div className="crispy-tunnel-wizard__form">
          <label className="crispy-discord-wizard__field">
            <span>Relay URL</span>
            <input
              type="text"
              value={draftRelayUrl}
              onChange={(e) => setDraftRelayUrl(e.target.value)}
              placeholder="https://crispy-code.com"
            />
          </label>
          <label className="crispy-discord-wizard__field">
            <span>Pairing Token</span>
            <input
              type="password"
              value={draftToken}
              onChange={(e) => setDraftToken(e.target.value)}
              placeholder="crsp_..."
            />
          </label>
          <label className="crispy-discord-wizard__field">
            <span>Machine Name (optional)</span>
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Defaults to hostname"
            />
          </label>
          <div className="crispy-discord-wizard__actions">
            <button
              className="crispy-cp-settings__provider-btn"
              disabled={!draftToken.trim() || !draftRelayUrl.trim()}
              onClick={handlePair}
            >
              Link Machine
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Paired state: compact summary ---
  const { text: statusText, className: statusClass } = statusLabel(tunnelStatus);
  const relayHost = (() => {
    try { return new URL(relayUrl).hostname; } catch { return relayUrl; }
  })();

  if (!editing) {
    return (
      <div className="crispy-tunnel-wizard">
        {hostToggleElements}
        <div className="crispy-discord-wizard__summary">
          <div className="crispy-discord-wizard__summary-row">
            <span className="crispy-discord-wizard__summary-label">Relay</span>
            <span className="crispy-discord-wizard__summary-value">
              {relayHost} &rarr; &quot;{tunnelName || '(unnamed)'}&quot;
            </span>
          </div>
          <div className="crispy-discord-wizard__summary-row">
            <span className="crispy-discord-wizard__summary-label">Status</span>
            <span className={`crispy-discord-wizard__summary-value ${statusClass}`}>
              {tunnelStatus.status === 'connected' && <span style={{ marginRight: 4 }}>&#x2022;</span>}
              {statusText}
            </span>
          </div>
          <span style={{ display: 'flex', gap: '4px' }}>
            <button className="crispy-cp-settings__provider-btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="crispy-cp-settings__provider-btn crispy-cp-settings__provider-btn--danger"
              onClick={handleUnpair}
              title="Unlink from relay"
            >
              &times;
            </button>
          </span>
        </div>
      </div>
    );
  }

  // --- Paired state: expanded edit ---
  return (
    <div className="crispy-tunnel-wizard">
      {hostToggleElements}
      <div className="crispy-discord-wizard__summary">
        <div className="crispy-discord-wizard__summary-row">
          <span className="crispy-discord-wizard__summary-label">Relay</span>
          <span className="crispy-discord-wizard__summary-value">{relayUrl}</span>
        </div>
        <div className="crispy-discord-wizard__summary-row">
          <span className="crispy-discord-wizard__summary-label">Machine</span>
          <span className="crispy-discord-wizard__summary-value">{tunnelName || '(unnamed)'}</span>
        </div>
        <div className="crispy-discord-wizard__summary-row">
          <span className="crispy-discord-wizard__summary-label">Tunnel ID</span>
          <span className="crispy-discord-wizard__summary-value" style={{ fontSize: '0.85em', opacity: 0.7 }}>
            {tunnelId}
          </span>
        </div>
        <div className="crispy-discord-wizard__summary-row">
          <span className="crispy-discord-wizard__summary-label">Status</span>
          <span className={`crispy-discord-wizard__summary-value ${statusClass}`}>
            {statusText}
          </span>
        </div>
      </div>
      <div className="crispy-discord-wizard__actions">
        <button
          className="crispy-cp-settings__provider-btn crispy-cp-settings__provider-btn--danger"
          onClick={handleUnpair}
        >
          Unlink Machine
        </button>
        <button className="crispy-cp-settings__provider-btn" onClick={() => setEditing(false)}>
          Done
        </button>
      </div>
    </div>
  );
}
