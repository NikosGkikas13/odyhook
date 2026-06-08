import { llmFor } from "@/lib/llm";

// Diagnose a single failed webhook delivery. The model is given a redacted
// view of the failure (URL host only, status, response snippet, content-type
// header, event shape) and returns a short summary + detail. The result is
// persisted once per delivery so the user pays for the call only once.

const SYSTEM_PROMPT = `You are a webhook reliability expert helping a developer diagnose a failed webhook delivery.

You are given:
- The destination URL (host only, for privacy)
- The HTTP status code the destination returned (or a network error)
- The first ~2 KB of the response body the destination returned
- The content-type and other relevant request headers
- The *shape* of the event payload (keys and value types, NOT actual values)

You must return exactly two sections, separated by a line that is literally \`---\`:

1. A ONE-SENTENCE summary of the most likely root cause.
2. A detailed explanation (2-6 sentences) describing the root cause and a concrete fix. Reference official documentation URLs where appropriate (Stripe, GitHub, etc). Do not invent URLs.

Do not wrap the response in markdown code fences. Do not use headings. Write in a direct, confident tone, but acknowledge uncertainty when the evidence is thin.`;

export type DiagnosisResult = {
  summary: string;
  detail: string;
  modelUsed: string;
};

export type DiagnosisInput = {
  destinationHost: string;
  method: string;
  responseCode: number | null;
  responseBodySnippet: string | null;
  lastError: string | null;
  requestHeaders: Record<string, string>;
  eventShape: unknown; // structural fingerprint, NOT raw payload
};

/**
 * Given a single failed delivery, ask Claude for a likely cause + fix.
 * Uses the user's own Anthropic key.
 */
export async function diagnoseDelivery(
  userId: string,
  input: DiagnosisInput,
): Promise<DiagnosisResult> {
  const llm = await llmFor(userId);

  const userMessage = [
    `Destination host: ${input.destinationHost}`,
    `Request method: ${input.method}`,
    `Response code: ${input.responseCode ?? "(network error, no response)"}`,
    input.lastError ? `Error: ${input.lastError}` : null,
    ``,
    `Request headers (redacted):`,
    "```json",
    JSON.stringify(input.requestHeaders, null, 2),
    "```",
    ``,
    `Response body (first 2KB):`,
    "```",
    (input.responseBodySnippet ?? "(empty)").slice(0, 2048),
    "```",
    ``,
    `Event payload shape (keys and types only):`,
    "```json",
    JSON.stringify(input.eventShape, null, 2).slice(0, 4000),
    "```",
    ``,
    `Diagnose the failure and suggest a concrete fix.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { text, model } = await llm.complete({
    tier: "standard",
    maxTokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const raw = text.trim();
  const [summaryRaw, ...rest] = raw.split(/^---$/m);
  const summary = (summaryRaw ?? "").trim() || "No summary returned";
  const detail = rest.join("---").trim() || raw;

  return { summary, detail, modelUsed: model };
}

/**
 * Build a structural fingerprint of a JSON value — keys and value *types*,
 * with no actual leaf values — so we can show Claude the shape without
 * leaking customer data.
 */
export function fingerprintShape(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0
      ? "array<empty>"
      : [fingerprintShape(value[0], depth + 1)];
  }
  const t = typeof value;
  if (t !== "object") return t;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = fingerprintShape(v, depth + 1);
  }
  return out;
}
