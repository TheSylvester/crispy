/**
 * Message View Config — Provider configuration types
 *
 * Type definitions for messageProviders in settings.json.
 * Validated at init time, hot-reloadable via onSettingsChanged.
 *
 * @module message-view/config
 */

export interface DiscordProviderConfig {
  id: string;
  type: 'discord';
  enabled: boolean;
  token: string;
  guildId: string;
  /** 'all' = auto-watch new sessions, 'manual' = only via !open */
  sessions: 'all' | 'manual';
}

export type MessageProviderConfig = DiscordProviderConfig;
