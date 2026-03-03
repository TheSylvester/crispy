/**
 * Settings Popup — gear icon with popup panel
 *
 * Gear icon rotates 45deg when pinned. Pop animation on initial pin.
 * Popup contains render mode select and provider management.
 * Click-outside closes popup.
 * Hover wobble animations are pure CSS — no React state needed.
 *
 * @module control-panel/SettingsPopup
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { SettingsIcon } from './icons.js';
import type { RenderMode } from '../../types.js';
import type { ToolViewOverride } from '../../context/PreferencesContext.js';
import type { WireProviderConfig, ProviderConfig } from '../../../core/settings/types.js';

interface SettingsPopupProps {
  pinned: boolean;
  onToggle: () => void;
  renderMode: RenderMode;
  onRenderModeChange: (mode: RenderMode) => void;
  toolViewOverride?: ToolViewOverride;
  onToolViewOverrideChange?: (override: ToolViewOverride) => void;
  debugMode: boolean;
  onDebugModeChange: (enabled: boolean) => void;
  toolPanelAutoOpen: boolean;
  onToolPanelAutoOpenChange: (enabled: boolean) => void;
  providers?: Record<string, WireProviderConfig>;
  onSaveProvider?: (slug: string, config: ProviderConfig) => Promise<void>;
  onDeleteProvider?: (slug: string) => void;
}

const RENDER_MODES: { value: RenderMode; label: string }[] = [
  { value: 'blocks', label: 'Blocks' },
  { value: 'yaml', label: 'YAML' },
  { value: 'compact', label: 'Compact' },
];

const TOOL_VIEW_MODES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'compact', label: 'Compact' },
  { value: 'expanded', label: 'Expanded' },
];

interface ProviderFormState {
  slug: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  modelDefault: string;
  modelOpus: string;
  modelSonnet: string;
  modelHaiku: string;
  timeout: string;
  enabled: boolean;
  isNew: boolean;
  /** Preserved through form round-trip — not editable in UI. */
  extraEnv?: Record<string, string>;
}

const EMPTY_FORM: ProviderFormState = {
  slug: '',
  label: '',
  baseUrl: '',
  apiKey: '',
  modelDefault: '',
  modelOpus: '',
  modelSonnet: '',
  modelHaiku: '',
  timeout: '',
  enabled: true,
  isNew: true,
};

function formFromProvider(slug: string, config: WireProviderConfig): ProviderFormState {
  return {
    slug,
    label: config.label,
    baseUrl: config.baseUrl,
    apiKey: '', // Leave empty — placeholder shows masked key
    modelDefault: config.models.default,
    modelOpus: config.models.opus ?? '',
    modelSonnet: config.models.sonnet ?? '',
    modelHaiku: config.models.haiku ?? '',
    timeout: config.timeout ? String(config.timeout) : '',
    enabled: config.enabled,
    isNew: false,
    extraEnv: config.extraEnv,
  };
}

function formToConfig(form: ProviderFormState): ProviderConfig {
  return {
    label: form.label,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    models: {
      default: form.modelDefault,
      ...(form.modelOpus && { opus: form.modelOpus }),
      ...(form.modelSonnet && { sonnet: form.modelSonnet }),
      ...(form.modelHaiku && { haiku: form.modelHaiku }),
    },
    ...(form.timeout && { timeout: parseInt(form.timeout, 10) }),
    ...(form.extraEnv && { extraEnv: form.extraEnv }),
    enabled: form.enabled,
  };
}

export function SettingsPopup({ pinned, onToggle, renderMode, onRenderModeChange, toolViewOverride, onToolViewOverrideChange, debugMode, onDebugModeChange, toolPanelAutoOpen, onToolPanelAutoOpenChange, providers, onSaveProvider, onDeleteProvider }: SettingsPopupProps): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [justPinned, setJustPinned] = useState(false);
  const [editForm, setEditForm] = useState<ProviderFormState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (pinned && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onToggle();
      }
    },
    [pinned, onToggle],
  );

  useEffect(() => {
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [handleClickOutside]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pinned) setJustPinned(true);
    onToggle();
  };

  const handleSaveForm = async () => {
    if (!editForm || !onSaveProvider) return;
    if (!editForm.slug || !editForm.label || !editForm.baseUrl || !editForm.modelDefault) return;
    setSaveError(null);
    setSaving(true);
    try {
      await onSaveProvider(editForm.slug, formToConfig(editForm));
      setEditForm(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const containerClass = [
    'crispy-cp-settings',
    pinned ? 'crispy-cp-settings--pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const btnClass = [
    'crispy-cp-settings__btn',
    justPinned ? 'animate-in' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={containerRef}
      className={containerClass}
    >
      <button
        className={btnClass}
        title="Display settings"
        onClick={handleClick}
        onAnimationEnd={() => setJustPinned(false)}
      >
        <SettingsIcon />
      </button>
      {pinned && (
        <div className="crispy-cp-settings__popup" onClick={(e) => e.stopPropagation()}>
          <div className="crispy-cp-settings__popup-header">Display Settings</div>
          <label className="crispy-cp-settings__row">
            <span>Render Mode</span>
            <select
              value={renderMode}
              onChange={(e) => onRenderModeChange(e.target.value as RenderMode)}
            >
              {RENDER_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {debugMode && onToolViewOverrideChange && (
            <label className="crispy-cp-settings__row">
              <span>Tool View</span>
              <select
                value={toolViewOverride ?? 'auto'}
                onChange={(e) => {
                  const val = e.target.value;
                  onToolViewOverrideChange(val === 'auto' ? null : val as ToolViewOverride);
                }}
              >
                {TOOL_VIEW_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="crispy-cp-settings__row">
            <span>Debug Mode</span>
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => onDebugModeChange(e.target.checked)}
            />
          </label>
          <label className="crispy-cp-settings__row">
            <span>Auto-open Tools</span>
            <input
              type="checkbox"
              checked={toolPanelAutoOpen}
              onChange={(e) => onToolPanelAutoOpenChange(e.target.checked)}
            />
          </label>

          {/* --- Providers Section --- */}
          {providers && onSaveProvider && onDeleteProvider && (
            <>
              <div className="crispy-cp-settings__section-header">Providers</div>
              <div className="crispy-cp-settings__provider-list">
                {Object.entries(providers).map(([slug, config]) => (
                  <div key={slug} className="crispy-cp-settings__provider-item">
                    <span>
                      <strong>{slug}</strong>{' '}
                      <span style={{ opacity: 0.6 }}>{config.label}</span>
                    </span>
                    <span style={{ display: 'flex', gap: '4px' }}>
                      <button
                        className="crispy-cp-settings__provider-btn"
                        onClick={() => { setSaveError(null); setEditForm(formFromProvider(slug, config)); }}
                        title="Edit provider"
                      >
                        Edit
                      </button>
                      <button
                        className="crispy-cp-settings__provider-btn crispy-cp-settings__provider-btn--danger"
                        onClick={() => onDeleteProvider(slug)}
                        title="Delete provider"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {!editForm && (
                <button
                  className="crispy-cp-settings__provider-btn"
                  onClick={() => { setSaveError(null); setEditForm({ ...EMPTY_FORM }); }}
                  style={{ marginTop: '4px' }}
                >
                  + Add Provider
                </button>
              )}
              {editForm && (
                <div className="crispy-cp-settings__provider-form">
                  <label>
                    <span>Slug</span>
                    <input
                      type="text"
                      value={editForm.slug}
                      disabled={!editForm.isNew}
                      placeholder="e.g. my-provider"
                      onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Label</span>
                    <input
                      type="text"
                      value={editForm.label}
                      placeholder="Display name"
                      onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Base URL</span>
                    <input
                      type="text"
                      value={editForm.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>API Key</span>
                    <input
                      type="password"
                      value={editForm.apiKey}
                      placeholder={editForm.isNew ? 'API key' : 'Leave empty to keep existing'}
                      onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Default Model</span>
                    <input
                      type="text"
                      value={editForm.modelDefault}
                      placeholder="model-name"
                      onChange={(e) => setEditForm({ ...editForm, modelDefault: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Opus Model</span>
                    <input
                      type="text"
                      value={editForm.modelOpus}
                      placeholder="(optional)"
                      onChange={(e) => setEditForm({ ...editForm, modelOpus: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Sonnet Model</span>
                    <input
                      type="text"
                      value={editForm.modelSonnet}
                      placeholder="(optional)"
                      onChange={(e) => setEditForm({ ...editForm, modelSonnet: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Haiku Model</span>
                    <input
                      type="text"
                      value={editForm.modelHaiku}
                      placeholder="(optional)"
                      onChange={(e) => setEditForm({ ...editForm, modelHaiku: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Timeout (ms)</span>
                    <input
                      type="number"
                      value={editForm.timeout}
                      placeholder="300000"
                      onChange={(e) => setEditForm({ ...editForm, timeout: e.target.value })}
                    />
                  </label>
                  <label style={{ flexDirection: 'row', gap: '8px' }}>
                    <span>Enabled</span>
                    <input
                      type="checkbox"
                      checked={editForm.enabled}
                      onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })}
                    />
                  </label>
                  {saveError && (
                    <div style={{ color: 'var(--vscode-errorForeground, #f44)', fontSize: '12px', padding: '4px 0' }}>
                      {saveError}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                    <button
                      className="crispy-cp-settings__provider-btn"
                      onClick={() => { setSaveError(null); setEditForm(null); }}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                    <button
                      className="crispy-cp-settings__provider-btn"
                      onClick={handleSaveForm}
                      disabled={saving || !editForm.slug || !editForm.label || !editForm.baseUrl || !editForm.modelDefault}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </span>
  );
}
