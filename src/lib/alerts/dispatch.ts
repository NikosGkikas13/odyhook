import { sendMail } from "../mailer";
import { decrypt, decryptJson } from "../crypto";
import { composeEmail, composeSlackBlocks, composeWebhookPayload, type AlertContext } from "./compose";
import { safeFetch, readCappedText } from "../safe-fetch";

const SLACK_TIMEOUT_MS = 10_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

export async function dispatchEmail(to: string, ctx: AlertContext): Promise<void> {
  const msg = composeEmail(ctx);
  await sendMail({ to, subject: msg.subject, text: msg.text });
}

export async function dispatchSlack(
  webhookUrlEnc: string,
  ctx: AlertContext,
): Promise<void> {
  const url = decrypt(webhookUrlEnc);
  const body = composeSlackBlocks(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    // safeFetch pins to the validated IP and refuses redirects (SSRF guard).
    const { res, close } = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    try {
      if (!res.ok) {
        const text = await readCappedText(res.body, 200).catch(() => "");
        throw new Error(`Slack POST ${res.status}: ${text}`);
      }
    } finally {
      await close().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchGenericWebhook(
  urlEnc: string,
  headersEnc: string | undefined,
  ctx: AlertContext,
): Promise<void> {
  const url = decrypt(urlEnc);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (headersEnc) {
    try {
      const decoded = decryptJson<Record<string, string>>(headersEnc);
      for (const [k, v] of Object.entries(decoded)) {
        // The body is JSON.stringify'd below — don't let a user header
        // claim content-type: application/xml and mis-tell the receiver.
        if (k.toLowerCase() === "content-type") continue;
        headers[k] = v;
      }
    } catch (err) {
      console.warn("[alerts] failed to decrypt webhook headers:", err);
    }
  }
  const payload = composeWebhookPayload(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    // safeFetch pins to the validated IP and refuses redirects (SSRF guard).
    const { res, close } = await safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try {
      if (!res.ok) {
        const text = await readCappedText(res.body, 200).catch(() => "");
        throw new Error(`Webhook POST ${res.status}: ${text}`);
      }
    } finally {
      await close().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
}
