/**
 * Message View Config — Provider configuration types
 *
 * Internal type for the resolved Discord provider config used by message-view.
 * Config is sourced from the settings store (discord.bot section).
 *
 * @module message-view/config
 */

export interface DiscordProviderConfig {
  id: string;
  type: 'discord';
  enabled: boolean;
  token: string;
  guildId: string;
  /** Resolved: discord override ?? turnDefaults fallback. */
  permissionMode: string | null;
  /** Hours of inactivity before auto-archiving a Discord thread. Default: 24. */
  archivalTimeoutHours: number;
  /** Numeric Discord user IDs allowed to interact. Empty = owner-only (resolved via OAuth). */
  allowedUserIds: string[];
  /** Heartbeat drain interval in ms. Default: 1500. */
  heartbeatIntervalMs?: number;
}
