import { z } from "zod";

export const ALERT_TRIGGERS = ["exhausted", "failureRate", "firstFailure"] as const;
export const AlertTriggerSchema = z.enum(ALERT_TRIGGERS);
export type AlertTrigger = z.infer<typeof AlertTriggerSchema>;

const EmailChannelSchema = z.object({
  enabled: z.boolean(),
});

const SlackChannelSchema = z.object({
  enabled: z.boolean(),
  // Stored encrypted; plaintext URL is never persisted. Server actions
  // validate the plaintext separately via validateSlackWebhookUrl before
  // encrypting.
  webhookUrlEnc: z.string().min(1),
});

const WebhookChannelSchema = z.object({
  enabled: z.boolean(),
  urlEnc: z.string().min(1),
  headersEnc: z.string().min(1).optional(),
});

const ChannelsSchema = z.object({
  email: EmailChannelSchema.optional(),
  slack: SlackChannelSchema.optional(),
  webhook: WebhookChannelSchema.optional(),
});

const TriggersSchema = z.object({
  exhausted: z.object({ enabled: z.boolean() }).optional(),
  failureRate: z
    .object({
      enabled: z.boolean(),
      ratePct: z.number().int().min(1).max(100),
      windowCount: z.number().int().min(2).max(200),
    })
    .optional(),
  firstFailure: z
    .object({
      enabled: z.boolean(),
      afterSuccessCount: z.number().int().min(1).max(50),
    })
    .optional(),
});

export const AlertConfigSchema = z
  .object({
    channels: ChannelsSchema.optional(),
    triggers: TriggersSchema.optional(),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict();

export type AlertConfig = z.infer<typeof AlertConfigSchema>;

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  channels: {},
  triggers: {},
  cooldownMinutes: 15,
};

const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\//;

export function validateSlackWebhookUrl(url: string): void {
  if (!SLACK_WEBHOOK_RE.test(url)) {
    throw new Error(
      "Slack webhook URL must start with https://hooks.slack.com/",
    );
  }
}

export function validateGenericWebhookUrl(url: string, appUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use https://");
  }
  if (appUrl) {
    let appHost: string;
    try {
      appHost = new URL(appUrl).host;
    } catch {
      appHost = "";
    }
    if (appHost && parsed.host === appHost) {
      throw new Error(
        "Webhook URL must not point back at Odyhook itself (would loop)",
      );
    }
  }
}
