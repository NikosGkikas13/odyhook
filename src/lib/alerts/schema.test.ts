import { describe, it, expect } from "vitest";
import {
  AlertConfigSchema,
  AlertTriggerSchema,
  DEFAULT_ALERT_CONFIG,
  validateSlackWebhookUrl,
  validateGenericWebhookUrl,
} from "./schema";

describe("AlertTriggerSchema", () => {
  it("accepts the three known trigger names", () => {
    for (const t of ["exhausted", "failureRate", "firstFailure"] as const) {
      expect(AlertTriggerSchema.parse(t)).toBe(t);
    }
  });

  it("rejects unknown trigger names", () => {
    expect(() => AlertTriggerSchema.parse("test")).toThrow();
    expect(() => AlertTriggerSchema.parse("")).toThrow();
  });
});

describe("AlertConfigSchema", () => {
  it("accepts the default config (all off, no channels)", () => {
    expect(AlertConfigSchema.parse(DEFAULT_ALERT_CONFIG)).toEqual(
      DEFAULT_ALERT_CONFIG,
    );
  });

  it("accepts a fully populated config", () => {
    const cfg = {
      channels: {
        email: { enabled: true },
        slack: { enabled: true, webhookUrlEnc: "ZW5jOnNsYWNr" },
        webhook: {
          enabled: true,
          urlEnc: "ZW5jOndlYmhvb2s=",
          headersEnc: "ZW5jOmhlYWRlcnM=",
        },
      },
      triggers: {
        exhausted: { enabled: true },
        failureRate: { enabled: true, ratePct: 50, windowCount: 20 },
        firstFailure: { enabled: true, afterSuccessCount: 5 },
      },
      cooldownMinutes: 30,
    };
    expect(AlertConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it("rejects ratePct out of [1,100]", () => {
    const bad = {
      triggers: {
        failureRate: { enabled: true, ratePct: 0, windowCount: 20 },
      },
    };
    expect(() => AlertConfigSchema.parse(bad)).toThrow();
    expect(() =>
      AlertConfigSchema.parse({
        triggers: {
          failureRate: { enabled: true, ratePct: 101, windowCount: 20 },
        },
      }),
    ).toThrow();
  });

  it("rejects windowCount out of [2,200]", () => {
    expect(() =>
      AlertConfigSchema.parse({
        triggers: {
          failureRate: { enabled: true, ratePct: 50, windowCount: 1 },
        },
      }),
    ).toThrow();
    expect(() =>
      AlertConfigSchema.parse({
        triggers: {
          failureRate: { enabled: true, ratePct: 50, windowCount: 201 },
        },
      }),
    ).toThrow();
  });

  it("rejects afterSuccessCount out of [1,50]", () => {
    expect(() =>
      AlertConfigSchema.parse({
        triggers: { firstFailure: { enabled: true, afterSuccessCount: 0 } },
      }),
    ).toThrow();
    expect(() =>
      AlertConfigSchema.parse({
        triggers: { firstFailure: { enabled: true, afterSuccessCount: 51 } },
      }),
    ).toThrow();
  });

  it("rejects cooldownMinutes out of [1,1440]", () => {
    expect(() =>
      AlertConfigSchema.parse({ cooldownMinutes: 0 }),
    ).toThrow();
    expect(() =>
      AlertConfigSchema.parse({ cooldownMinutes: 1441 }),
    ).toThrow();
  });
});

describe("validateSlackWebhookUrl", () => {
  it("accepts an official Slack webhook URL", () => {
    expect(() =>
      validateSlackWebhookUrl(
        "https://hooks.slack.com/services/T000/B000/abcdef",
      ),
    ).not.toThrow();
  });

  it("rejects non-Slack URLs", () => {
    expect(() =>
      validateSlackWebhookUrl("https://example.com/webhook"),
    ).toThrow();
    expect(() =>
      validateSlackWebhookUrl("http://hooks.slack.com/services/x"),
    ).toThrow();
  });
});

describe("validateGenericWebhookUrl", () => {
  it("accepts an https URL on an unrelated host", () => {
    expect(() =>
      validateGenericWebhookUrl(
        "https://example.com/hook",
        "https://odyhook.dev",
      ),
    ).not.toThrow();
  });

  it("rejects non-https URLs", () => {
    expect(() =>
      validateGenericWebhookUrl(
        "http://example.com/hook",
        "https://odyhook.dev",
      ),
    ).toThrow();
  });

  it("rejects URLs whose host matches the app URL host (self-loop guard)", () => {
    expect(() =>
      validateGenericWebhookUrl(
        "https://odyhook.dev/api/ingest/x",
        "https://odyhook.dev",
      ),
    ).toThrow();
  });

  it("does not throw when appUrl is empty (dev / unconfigured)", () => {
    expect(() =>
      validateGenericWebhookUrl("https://example.com/hook", ""),
    ).not.toThrow();
  });
});
