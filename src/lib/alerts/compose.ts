import type { AlertTrigger } from "./schema";

export type AlertContext = {
  destinationName: string;
  destinationId: string;
  trigger: AlertTrigger;
  deliveryId: string;
  lastError?: string;
  // Optional, populated for failureRate:
  failureCount?: number;
  windowSize?: number;
  // Optional, populated for firstFailure:
  afterSuccesses?: number;
};

const TRIGGER_LABEL: Record<AlertTrigger, string> = {
  exhausted: "exhausted (all retries used)",
  failureRate: "high failure rate",
  firstFailure: "first failure after recovery",
};

function sanitizeForSubject(s: string): string {
  return s.replace(/[\r\n\f]/g, "");
}

export type ComposedEmail = { subject: string; text: string };

export function composeEmail(ctx: AlertContext): ComposedEmail {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const link = baseUrl
    ? `${baseUrl}/destinations/${ctx.destinationId}`
    : `/destinations/${ctx.destinationId}`;
  const safeName = sanitizeForSubject(ctx.destinationName);
  const reason = (ctx.lastError ?? "").slice(0, 300);
  const detailLines: string[] = [];
  if (ctx.failureCount != null && ctx.windowSize != null) {
    detailLines.push(
      `Failures: ${ctx.failureCount} of the last ${ctx.windowSize} deliveries.`,
    );
  }
  if (ctx.afterSuccesses != null) {
    detailLines.push(
      `This destination delivered ${ctx.afterSuccesses} events successfully before this failure.`,
    );
  }
  if (reason) detailLines.push(`Last error: ${reason}`);

  return {
    subject: `Odyhook: ${TRIGGER_LABEL[ctx.trigger]} on "${safeName}"`,
    text: [
      `Heads up — Odyhook detected ${TRIGGER_LABEL[ctx.trigger]} on your destination "${safeName}".`,
      "",
      ...detailLines,
      "",
      `Inspect or pause it here: ${link}`,
    ]
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n"),
  };
}

export type SlackBlocks = {
  blocks: Array<Record<string, unknown>>;
};

export function composeSlackBlocks(ctx: AlertContext): SlackBlocks {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const link = baseUrl
    ? `${baseUrl}/destinations/${ctx.destinationId}`
    : `/destinations/${ctx.destinationId}`;
  const fields: Array<{ type: "mrkdwn"; text: string }> = [];
  if (ctx.failureCount != null && ctx.windowSize != null) {
    fields.push({
      type: "mrkdwn",
      text: `*Failures:* ${ctx.failureCount}/${ctx.windowSize}`,
    });
  }
  if (ctx.afterSuccesses != null) {
    fields.push({
      type: "mrkdwn",
      text: `*Prior successes:* ${ctx.afterSuccesses}`,
    });
  }
  if (ctx.lastError) {
    fields.push({
      type: "mrkdwn",
      text: `*Last error:* \`${ctx.lastError.slice(0, 200)}\``,
    });
  }
  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Odyhook: ${TRIGGER_LABEL[ctx.trigger]}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Destination:* <${link}|${ctx.destinationName}>`,
        },
        ...(fields.length ? { fields } : {}),
      },
    ],
  };
}

export type WebhookPayload = {
  event: "alert";
  trigger: AlertTrigger;
  destination: { id: string; name: string };
  deliveryId: string;
  lastError?: string;
  failureCount?: number;
  windowSize?: number;
  afterSuccesses?: number;
  firedAt: string;
};

export function composeWebhookPayload(ctx: AlertContext): WebhookPayload {
  return {
    event: "alert",
    trigger: ctx.trigger,
    destination: { id: ctx.destinationId, name: ctx.destinationName },
    deliveryId: ctx.deliveryId,
    lastError: ctx.lastError,
    failureCount: ctx.failureCount,
    windowSize: ctx.windowSize,
    afterSuccesses: ctx.afterSuccesses,
    firedAt: new Date().toISOString(),
  };
}
