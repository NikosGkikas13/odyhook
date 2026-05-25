import { AlertConfigSchema, DEFAULT_ALERT_CONFIG, type AlertConfig } from "./schema";

/**
 * Parse a JSON column value (from Prisma) into a validated AlertConfig.
 * Returns null on null input or validation failure — never throws.
 */
export function parseStoredConfig(value: unknown): AlertConfig | null {
  if (value == null) return null;
  const result = AlertConfigSchema.safeParse(value);
  if (!result.success) {
    console.warn("[alerts] discarding malformed alertConfigJson:", result.error.message);
    return null;
  }
  return result.data;
}

/**
 * Shallow-merge per top-level key, with destination override taking
 * precedence on a per-channel and per-trigger basis. cooldownMinutes is
 * a scalar override.
 */
export function mergeAlertConfigs(
  user: AlertConfig | null,
  destination: AlertConfig | null,
): AlertConfig {
  const out: AlertConfig = {
    channels: { ...user?.channels, ...destination?.channels },
    triggers: { ...user?.triggers, ...destination?.triggers },
    cooldownMinutes:
      destination?.cooldownMinutes ??
      user?.cooldownMinutes ??
      DEFAULT_ALERT_CONFIG.cooldownMinutes,
  };
  return out;
}
