/**
 * Discord Setup Wizard — step-by-step guided onboarding for Discord bot setup
 *
 * Shows numbered instructions inline next to input fields. First-time users
 * see the full wizard; returning users see a compact summary with an Edit button.
 * Token validation and app info fetching go through host RPCs (the webview
 * cannot make cross-origin REST calls to Discord directly).
 *
 * @module control-panel/DiscordSetupWizard
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import type { DiscordBotSettings } from '../../../core/settings/types.js';

// ---------------------------------------------------------------------------
// Permission bits the bot needs (from discord-transport.ts and forum.ts usage)
// ---------------------------------------------------------------------------
const PERMISSION_BITS = {
  MANAGE_CHANNELS:            0x10n,
  VIEW_CHANNEL:               0x400n,
  SEND_MESSAGES:              0x800n,
  MANAGE_MESSAGES:            0x2000n,
  ATTACH_FILES:               0x8000n,
  READ_MESSAGE_HISTORY:       0x10000n,
  ADD_REACTIONS:              0x40n,
  MANAGE_THREADS:             0x400000000n,
  SEND_MESSAGES_IN_THREADS:   0x4000000000n,
} as const;

const COMPUTED_PERMISSIONS = Object.values(PERMISSION_BITS).reduce((a, b) => a | b, 0n);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface DiscordSetupWizardProps {
  enabled: boolean;
  guildId: string;
  token: string;
  allowedUserIds: string[];
  enableInVscode: boolean;
  enableInDevServer: boolean;
  enableInDaemon: boolean;
  enableInTauri: boolean;
  onUpdateDiscord: (patch: Partial<DiscordBotSettings>) => void;
  /** Notify parent when the wizard has unsaved draft state (prevents click-outside close). */
  onDirtyChange?: (dirty: boolean) => void;
}

// ---------------------------------------------------------------------------
// Validation state
// ---------------------------------------------------------------------------
interface TokenValidation {
  status: 'idle' | 'validating' | 'valid' | 'invalid';
  username?: string;
  userId?: string;
  error?: string;
}

interface AppInfo {
  appId: string;
  name: string;
}

export function DiscordSetupWizard({
  enabled,
  guildId,
  token,
  allowedUserIds,
  enableInVscode,
  enableInDevServer,
  enableInDaemon,
  enableInTauri,
  onUpdateDiscord,
  onDirtyChange,
}: DiscordSetupWizardProps) {
  const transport = useTransport();
  const environment = useEnvironment();

  // Local draft state for first-time setup (batch save)
  const isFirstTime = enabled && !token;
  const [draftToken, setDraftToken] = useState('');
  const [draftGuildId, setDraftGuildId] = useState('');
  const [draftAllowedUserIds, setDraftAllowedUserIds] = useState('');
  // Track whether user explicitly changed the token (to avoid saving masked values)
  const [tokenTouched, setTokenTouched] = useState(false);

  // Wizard vs compact view
  const [editing, setEditing] = useState(false);
  const hasExistingConfig = enabled && !!token;

  // Notify parent when wizard has unsaved state (first-time or editing)
  useEffect(() => {
    onDirtyChange?.(isFirstTime || editing);
  }, [isFirstTime, editing, onDirtyChange]);

  // Validation state
  const [validation, setValidation] = useState<TokenValidation>({ status: 'idle' });
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [intentsConfirmed, setIntentsConfirmed] = useState(false);

  // Collapsible advanced section
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Debounce timer for token validation
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (validateTimer.current) clearTimeout(validateTimer.current); };
  }, []);

  const validateToken = useCallback(async (t: string) => {
    if (!t.trim()) {
      setValidation({ status: 'idle' });
      setAppInfo(null);
      return;
    }
    setValidation({ status: 'validating' });
    try {
      const result = await transport.validateDiscordToken(t);
      if (result.valid) {
        setValidation({ status: 'valid', username: result.username, userId: result.id });
        // Also fetch app info for invite URL
        const info = await transport.getDiscordAppInfo(t);
        setAppInfo(info);
      } else {
        setValidation({ status: 'invalid', error: result.error });
        setAppInfo(null);
      }
    } catch {
      setValidation({ status: 'invalid', error: 'Network error' });
      setAppInfo(null);
    }
  }, [transport]);

  const handleTokenBlur = useCallback(() => {
    // Clear pending debounce to avoid double-fire
    if (validateTimer.current) { clearTimeout(validateTimer.current); validateTimer.current = null; }
    const t = (isFirstTime || editing) ? draftToken : token;
    if (t.trim()) validateToken(t);
  }, [isFirstTime, editing, draftToken, token, validateToken]);

  const handleTokenChange = useCallback((value: string) => {
    if (isFirstTime || editing) {
      setDraftToken(value);
      setTokenTouched(true);
    } else {
      onUpdateDiscord({ token: value });
    }
    // Reset validation on change
    setValidation({ status: 'idle' });
    setAppInfo(null);
    // Auto-validate after brief delay
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => {
      if (value.trim()) validateToken(value);
    }, 800);
  }, [isFirstTime, editing, onUpdateDiscord, validateToken]);

  const inviteUrl = appInfo
    ? `https://discord.com/oauth2/authorize?client_id=${appInfo.appId}&scope=bot+applications.commands&permissions=${COMPUTED_PERMISSIONS.toString()}`
    : null;

  const handleSave = useCallback(() => {
    const patch: Partial<DiscordBotSettings> = {
      enabled: true,
      guildId: draftGuildId,
      allowedUserIds: draftAllowedUserIds.split(',').map(s => s.trim()).filter(Boolean),
    };
    // Only include token if user explicitly changed it (avoids saving masked values)
    if (tokenTouched) patch.token = draftToken;
    onUpdateDiscord(patch);
    setEditing(false);
    setTokenTouched(false);
  }, [onUpdateDiscord, draftToken, draftGuildId, draftAllowedUserIds, tokenTouched]);

  const handleEdit = useCallback(() => {
    setDraftToken(token);
    setDraftGuildId(guildId);
    setDraftAllowedUserIds(allowedUserIds.join(', '));
    setTokenTouched(false);
    setEditing(true);
    // Don't auto-validate — token prop is masked, validation would fail.
    // User must re-enter token if they want to change it.
  }, [token, guildId, allowedUserIds]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setValidation({ status: 'idle' });
    setAppInfo(null);
  }, []);

  // --- Enable toggle ---
  if (!enabled) {
    return (
      <label className="crispy-cp-settings__row">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={false}
          onChange={() => onUpdateDiscord({ enabled: true })}
        />
      </label>
    );
  }

  // Per-host toggle: show only the flag(s) relevant to this host type
  const hostToggles = environment === 'vscode'
    ? [{ label: 'Enable in VS Code', field: 'enableInVscode' as const, value: enableInVscode }]
    : environment === 'tauri'
    ? [{ label: 'Enable in Desktop', field: 'enableInTauri' as const, value: enableInTauri }]
    : [
      { label: 'Enable in Dev Server', field: 'enableInDevServer' as const, value: enableInDevServer },
      { label: 'Enable in Desktop (Tauri)', field: 'enableInTauri' as const, value: enableInTauri },
      { label: 'Enable in Daemon', field: 'enableInDaemon' as const, value: enableInDaemon },
    ];

  const hostToggleElements = hostToggles.map((t) => (
    <label key={t.field} className="crispy-cp-settings__row">
      <span>{t.label}</span>
      <input
        type="checkbox"
        checked={t.value}
        onChange={(e) => onUpdateDiscord({ [t.field]: e.target.checked })}
      />
    </label>
  ));

  // --- Compact summary for returning users ---
  if (hasExistingConfig && !editing) {
    return (
      <div className="crispy-discord-wizard">
        <label className="crispy-cp-settings__row">
          <span>Enabled</span>
          <input
            type="checkbox"
            checked={true}
            onChange={() => onUpdateDiscord({ enabled: false })}
          />
        </label>
        {hostToggleElements}
        <div className="crispy-discord-wizard__summary">
          <div className="crispy-discord-wizard__summary-row">
            <span className="crispy-discord-wizard__summary-label">Bot</span>
            <span className="crispy-discord-wizard__summary-value">
              {validation.status === 'valid' ? validation.username : '(configured)'}
            </span>
          </div>
          <div className="crispy-discord-wizard__summary-row">
            <span className="crispy-discord-wizard__summary-label">Guild</span>
            <span className="crispy-discord-wizard__summary-value">{guildId || '(not set)'}</span>
          </div>
          <span style={{ display: 'flex', gap: '4px' }}>
            <button className="crispy-cp-settings__provider-btn" onClick={handleEdit}>
              Edit
            </button>
            <button
              className="crispy-cp-settings__provider-btn crispy-cp-settings__provider-btn--danger"
              onClick={() => onUpdateDiscord({ enabled: false, token: '', guildId: '', allowedUserIds: [] })}
              title="Delete Discord bot configuration"
            >
              ×
            </button>
          </span>
        </div>
      </div>
    );
  }

  // --- Full wizard / edit form ---
  const activeToken = (isFirstTime || editing) ? draftToken : token;
  const activeGuildId = (isFirstTime || editing) ? draftGuildId : guildId;
  const showWizardSteps = isFirstTime && !editing;
  // First-time: require valid token + intents confirmed + guild ID
  // Edit mode: require guild ID; only require valid token if user changed it
  const tokenValid = validation.status === 'valid' || (editing && !tokenTouched);
  const canSave = tokenValid && activeGuildId.trim() !== '' && (showWizardSteps ? intentsConfirmed : true);

  return (
    <div className="crispy-discord-wizard">
      <label className="crispy-cp-settings__row">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={true}
          onChange={() => onUpdateDiscord({ enabled: false })}
        />
      </label>
      {hostToggleElements}

      <div className="crispy-discord-wizard__form">
        {/* Step 1: Create Application & Token */}
        {showWizardSteps && (
          <div className="crispy-discord-wizard__step">
            <div className="crispy-discord-wizard__step-number">1</div>
            <div className="crispy-discord-wizard__step-content">
              <div className="crispy-discord-wizard__step-title">Create Application</div>
              <ol className="crispy-discord-wizard__instructions">
                <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a></li>
                <li>Click <strong>New Application</strong>, name it (e.g. &quot;CrispyBot&quot;)</li>
                <li>Go to <strong>Bot</strong> → click <strong>Reset Token</strong> → copy the token</li>
              </ol>
            </div>
          </div>
        )}

        <label className="crispy-discord-wizard__field">
          <span>Bot Token</span>
          <div className="crispy-discord-wizard__input-row">
            <input
              type="password"
              value={activeToken}
              onChange={(e) => handleTokenChange(e.target.value)}
              onBlur={handleTokenBlur}
              placeholder="Paste bot token here"
            />
            {validation.status === 'validating' && (
              <span className="crispy-discord-wizard__badge crispy-discord-wizard__badge--pending">…</span>
            )}
            {validation.status === 'valid' && (
              <span className="crispy-discord-wizard__badge crispy-discord-wizard__badge--ok">✓ {validation.username}</span>
            )}
            {validation.status === 'invalid' && (
              <span className="crispy-discord-wizard__badge crispy-discord-wizard__badge--err">{validation.error || 'Invalid token'}</span>
            )}
          </div>
        </label>

        {/* Step 2: Enable Intents */}
        {showWizardSteps && (
          <div className="crispy-discord-wizard__step">
            <div className="crispy-discord-wizard__step-number">2</div>
            <div className="crispy-discord-wizard__step-content">
              <div className="crispy-discord-wizard__step-title">Enable Intents</div>
              <p className="crispy-discord-wizard__instructions-text">
                In the Developer Portal: <strong>Bot</strong> → <strong>Privileged Gateway Intents</strong><br />
                Enable: <strong>Message Content Intent</strong>
              </p>
              <label className="crispy-discord-wizard__checkbox">
                <input
                  type="checkbox"
                  checked={intentsConfirmed}
                  onChange={(e) => setIntentsConfirmed(e.target.checked)}
                />
                <span>I&apos;ve enabled Message Content Intent</span>
              </label>
            </div>
          </div>
        )}

        {/* Step 3: Invite Bot */}
        {showWizardSteps && (
          <div className="crispy-discord-wizard__step">
            <div className="crispy-discord-wizard__step-number">3</div>
            <div className="crispy-discord-wizard__step-content">
              <div className="crispy-discord-wizard__step-title">Invite Bot to Server</div>
              {inviteUrl ? (
                <div className="crispy-discord-wizard__invite">
                  <a href={inviteUrl} target="_blank" rel="noopener noreferrer">Open invite link</a>
                  <button
                    className="crispy-cp-settings__provider-btn"
                    onClick={() => navigator.clipboard.writeText(inviteUrl)}
                  >
                    Copy URL
                  </button>
                </div>
              ) : validation.status === 'valid' && !appInfo ? (
                <p className="crispy-discord-wizard__instructions-text crispy-discord-wizard__instructions-text--dim">
                  Could not fetch application info. Verify this is a Bot token (not a user token).
                </p>
              ) : (
                <p className="crispy-discord-wizard__instructions-text crispy-discord-wizard__instructions-text--dim">
                  Paste a valid bot token above to generate the invite link.
                </p>
              )}
            </div>
          </div>
        )}

        <label className="crispy-discord-wizard__field">
          <span>Guild ID</span>
          <input
            type="text"
            value={activeGuildId}
            onChange={(e) => {
              if (isFirstTime || editing) setDraftGuildId(e.target.value);
              else onUpdateDiscord({ guildId: e.target.value });
            }}
            placeholder="Discord server ID"
          />
          {showWizardSteps && (
            <span className="crispy-discord-wizard__hint">
              Right-click your server name → Copy Server ID (enable Developer Mode in Discord settings first)
            </span>
          )}
        </label>

        {/* Step 4: Advanced (collapsed) */}
        {(showWizardSteps || editing) && (
          <div className="crispy-discord-wizard__advanced">
            <button
              className="crispy-discord-wizard__advanced-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              {advancedOpen ? '▾' : '▸'} Configure Access
            </button>
            {advancedOpen && (
              <div className="crispy-discord-wizard__advanced-body">
                <label className="crispy-discord-wizard__field">
                  <span>Allowed User IDs</span>
                  <input
                    type="text"
                    value={(isFirstTime || editing) ? draftAllowedUserIds : allowedUserIds.join(', ')}
                    onChange={(e) => {
                      if (isFirstTime || editing) setDraftAllowedUserIds(e.target.value);
                      else onUpdateDiscord({
                        allowedUserIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                      });
                    }}
                    placeholder="Comma-separated Discord user IDs"
                  />
                  <span className="crispy-discord-wizard__hint">
                    Your owner ID is auto-detected. Add others here.
                  </span>
                </label>
              </div>
            )}
          </div>
        )}

        {/* Save / Cancel for first-time or edit mode */}
        {(isFirstTime || editing) && (
          <div className="crispy-discord-wizard__actions">
            <button
              className="crispy-cp-settings__provider-btn"
              disabled={!canSave}
              onClick={handleSave}
              title={!canSave ? 'Validate token and enter Guild ID first' : undefined}
            >
              Save
            </button>
            {editing && (
              <button className="crispy-cp-settings__provider-btn" onClick={handleCancel}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
