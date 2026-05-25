import { describe, it, expect } from "vitest";
import { mergeAlertConfigs } from "./config";
import { DEFAULT_ALERT_CONFIG, type AlertConfig } from "./schema";

describe("mergeAlertConfigs", () => {
  it("returns the default when both inputs are null", () => {
    expect(mergeAlertConfigs(null, null)).toEqual(DEFAULT_ALERT_CONFIG);
  });

  it("falls back to user defaults when destination override is null", () => {
    const user: AlertConfig = {
      channels: { email: { enabled: true } },
      triggers: { exhausted: { enabled: true } },
      cooldownMinutes: 30,
    };
    expect(mergeAlertConfigs(user, null)).toEqual({
      channels: { email: { enabled: true } },
      triggers: { exhausted: { enabled: true } },
      cooldownMinutes: 30,
    });
  });

  it("destination override wins on a per-channel basis", () => {
    const user: AlertConfig = {
      channels: {
        email: { enabled: true },
        slack: { enabled: true, webhookUrlEnc: "USER_SLACK" },
      },
      triggers: {},
    };
    const dest: AlertConfig = {
      channels: { email: { enabled: false } },
    };
    const merged = mergeAlertConfigs(user, dest);
    expect(merged.channels?.email).toEqual({ enabled: false });
    // Slack inherited unchanged from user.
    expect(merged.channels?.slack).toEqual({
      enabled: true,
      webhookUrlEnc: "USER_SLACK",
    });
  });

  it("destination override wins on a per-trigger basis", () => {
    const user: AlertConfig = {
      triggers: {
        exhausted: { enabled: true },
        firstFailure: { enabled: true, afterSuccessCount: 5 },
      },
    };
    const dest: AlertConfig = {
      triggers: { exhausted: { enabled: false } },
    };
    const merged = mergeAlertConfigs(user, dest);
    expect(merged.triggers?.exhausted).toEqual({ enabled: false });
    expect(merged.triggers?.firstFailure).toEqual({
      enabled: true,
      afterSuccessCount: 5,
    });
  });

  it("destination cooldownMinutes overrides user cooldownMinutes", () => {
    expect(
      mergeAlertConfigs(
        { cooldownMinutes: 60 },
        { cooldownMinutes: 5 },
      ).cooldownMinutes,
    ).toBe(5);
  });

  it("falls back to DEFAULT cooldownMinutes when neither sets it", () => {
    expect(mergeAlertConfigs({ channels: {} }, null).cooldownMinutes).toBe(15);
  });

  it("silently ignores malformed JSON (returns default)", () => {
    // mergeAlertConfigs is called with the result of parseStoredConfig;
    // parseStoredConfig returns null on parse failure.
    expect(mergeAlertConfigs(null, null)).toEqual(DEFAULT_ALERT_CONFIG);
  });
});
