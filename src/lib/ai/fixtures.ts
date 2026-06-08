import type { LlmClient } from "@/lib/llm";
import { extractJsonText } from "./json";

/** Thrown when the model's output can't be used as a fixture (a user-facing,
 *  not infrastructure, failure). The API maps this to 400; anything else is a 500. */
export class FixtureGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureGenerationError";
  }
}

const SYSTEM_PROMPT = `You generate a single realistic webhook payload, as JSON, for testing a developer's integration.

Rules:
- Output ONLY one JSON object — no prose, no markdown, no code fences.
- Make the payload realistic for the event the user describes: plausible ids, amounts, timestamps, and nested structure.
- If recent real payloads for this source are provided, match their field names and shape closely.
- If a provider is hinted (e.g. "stripe", "github"), follow that provider's known payload conventions.
- Do not include signature/credential headers — only the request body JSON.`;

export type FixtureResult = {
  /** The generated payload as a JSON string, ready to POST as a request body. */
  body: string;
  /** The model that produced it. */
  model: string;
  /** How many real sample events grounded the generation (0 if none). */
  groundedOn: number;
};

export type GenerateFixtureOpts = {
  llm: LlmClient;
  prompt: string;
  sampleBodies: string[];
  verifyStyle: string | null;
};

/**
 * Ask Claude to generate one realistic webhook fixture for `prompt`, grounded
 * in up to 5 recent sample bodies and the source's provider hint. Returns the
 * payload as a JSON string. Throws if the model does not return valid JSON.
 */
export async function generateFixture(opts: GenerateFixtureOpts): Promise<FixtureResult> {
  const { llm, prompt, sampleBodies, verifyStyle } = opts;
  const samples = sampleBodies.slice(0, 5);

  const parts = [`Describe the event to generate: ${prompt}`];
  if (verifyStyle) parts.push(`Provider hint: ${verifyStyle}`);
  if (samples.length > 0) {
    // Sample bodies are untrusted external webhook content embedded into the
    // prompt. The trust boundary holds because the output must still parse as
    // JSON and the user reviews it (and can --dry-run) before anything is sent;
    // worst case is a different-but-valid payload, not code execution.
    // Cap each sample individually so we never feed the model a body that was
    // truncated mid-token (which would corrupt the grounding context).
    const MAX_SAMPLE_CHARS = 1200; // ~1 KB each; 5 × 1200 ≈ 6000 total
    const encoded = samples.map((s) => s.slice(0, MAX_SAMPLE_CHARS)).join("\n---\n");
    parts.push(
      `Recent real payloads for this source — match their shape:`,
      "```json",
      encoded,
      "```",
    );
  }
  parts.push("Output ONLY the JSON object for the new payload.");

  const { text, model } = await llm.complete({
    tier: "standard",
    maxTokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: parts.join("\n") }],
  });

  const raw = extractJsonText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FixtureGenerationError("the model did not return valid JSON — try rephrasing the description");
  }

  return {
    body: JSON.stringify(parsed),
    model,
    groundedOn: samples.length,
  };
}
