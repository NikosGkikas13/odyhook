"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import {
  AlertConfigSchema,
  validateSlackWebhookUrl,
  validateGenericWebhookUrl,
  type AlertConfig,
} from "@/lib/alerts/schema";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

// FormData shape — strings only. The page sends each field as a separate
// FormData entry; we assemble the AlertConfig here. Unchecked checkbox =
// no entry in FormData, which we read as `false`.
function parseFormToConfig(form: FormData, appUrl: string): AlertConfig {
  const cfg: AlertConfig = { channels: {}, triggers: {}, cooldownMinutes: 15 };

  // Email channel
  const emailOn = form.get("channel.email.enabled") === "on";
  if (emailOn) {
    cfg.channels!.email = { enabled: true };
  }

  // Slack channel
  const slackOn = form.get("channel.slack.enabled") === "on";
  const slackUrl = String(form.get("channel.slack.url") ?? "").trim();
  if (slackOn || slackUrl) {
    if (!slackUrl) {
      throw new Error("Slack channel enabled but webhook URL is empty");
    }
    validateSlackWebhookUrl(slackUrl);
    cfg.channels!.slack = {
      enabled: slackOn,
      webhookUrlEnc: encrypt(slackUrl),
    };
  }

  // Generic webhook channel
  const webhookOn = form.get("channel.webhook.enabled") === "on";
  const webhookUrl = String(form.get("channel.webhook.url") ?? "").trim();
  const webhookHeaders = String(form.get("channel.webhook.headers") ?? "").trim();
  if (webhookOn || webhookUrl) {
    if (!webhookUrl) {
      throw new Error("Webhook channel enabled but URL is empty");
    }
    validateGenericWebhookUrl(webhookUrl, appUrl);
    let headersEnc: string | undefined;
    if (webhookHeaders) {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(webhookHeaders) as Record<string, string>;
      } catch {
        throw new Error("Webhook headers must be a JSON object of strings");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("Webhook headers must be a JSON object");
      }
      if (Object.keys(parsed).length > 10) {
        throw new Error("Webhook headers: at most 10 entries");
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string") {
          throw new Error(`Webhook header ${k} must be a string`);
        }
      }
      headersEnc = encryptJson(parsed);
    }
    cfg.channels!.webhook = {
      enabled: webhookOn,
      urlEnc: encrypt(webhookUrl),
      ...(headersEnc ? { headersEnc } : {}),
    };
  }

  // Triggers
  if (form.get("trigger.exhausted.enabled") === "on") {
    cfg.triggers!.exhausted = { enabled: true };
  }
  if (form.get("trigger.failureRate.enabled") === "on") {
    cfg.triggers!.failureRate = {
      enabled: true,
      ratePct: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(form.get("trigger.failureRate.ratePct") ?? 50),
      windowCount: z.coerce
        .number()
        .int()
        .min(2)
        .max(200)
        .parse(form.get("trigger.failureRate.windowCount") ?? 20),
    };
  }
  if (form.get("trigger.firstFailure.enabled") === "on") {
    cfg.triggers!.firstFailure = {
      enabled: true,
      afterSuccessCount: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(form.get("trigger.firstFailure.afterSuccessCount") ?? 5),
    };
  }

  const cooldown = form.get("cooldownMinutes");
  if (cooldown != null && String(cooldown).length > 0) {
    cfg.cooldownMinutes = z.coerce.number().int().min(1).max(1440).parse(cooldown);
  }

  // Final defense — bounce anything that survives the field-by-field parse
  // but doesn't match the canonical schema.
  return AlertConfigSchema.parse(cfg);
}

export async function saveUserAlerts(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const cfg = parseFormToConfig(formData, appUrl);
  await prisma.user.update({
    where: { id: userId },
    data: { alertConfigJson: cfg as never },
  });
  revalidatePath("/settings/alerts");
}

export async function saveDestinationAlerts(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const destinationId = String(formData.get("destinationId") ?? "");
  if (!destinationId) throw new Error("destinationId is required");
  const dest = await prisma.destination.findFirst({
    where: { id: destinationId, userId },
    select: { id: true },
  });
  if (!dest) throw new Error("not found");
  const useDefaults = formData.get("useDefaults") === "on";
  if (useDefaults) {
    await prisma.destination.update({
      where: { id: destinationId },
      data: { alertConfigJson: null as never },
    });
  } else {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const cfg = parseFormToConfig(formData, appUrl);
    await prisma.destination.update({
      where: { id: destinationId },
      data: { alertConfigJson: cfg as never },
    });
  }
  revalidatePath(`/destinations/${destinationId}`);
  revalidatePath("/destinations");
}

const TEST_CHANNELS = ["email", "slack", "webhook"] as const;
type TestChannel = (typeof TEST_CHANNELS)[number];

export async function sendTestAlert(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const channel = String(formData.get("channel") ?? "") as TestChannel;
  if (!TEST_CHANNELS.includes(channel)) {
    throw new Error(`unknown test channel: ${channel}`);
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, alertConfigJson: true },
  });
  // Lazy-load dispatch so the server-action surface doesn't pull worker
  // deps when only rendering the page.
  const { parseStoredConfig } = await import("@/lib/alerts/config");
  const { dispatchEmail, dispatchSlack, dispatchGenericWebhook } = await import(
    "@/lib/alerts/dispatch"
  );
  const cfg = parseStoredConfig(user.alertConfigJson);
  const ctx = {
    destinationId: "test",
    destinationName: "Test destination",
    trigger: "exhausted" as const,
    deliveryId: "test",
    lastError: "Test alert from /settings/alerts",
  };
  if (channel === "email" && cfg?.channels?.email?.enabled) {
    await dispatchEmail(user.email, ctx);
    return;
  }
  if (channel === "slack" && cfg?.channels?.slack?.enabled) {
    await dispatchSlack(cfg.channels.slack.webhookUrlEnc, ctx);
    return;
  }
  if (channel === "webhook" && cfg?.channels?.webhook?.enabled) {
    await dispatchGenericWebhook(
      cfg.channels.webhook.urlEnc,
      cfg.channels.webhook.headersEnc,
      ctx,
    );
    return;
  }
  throw new Error(`channel ${channel} is not enabled in your alert config`);
}
