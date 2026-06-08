import { llmFor } from "@/lib/llm";
import { runTransformation } from "@/lib/sandbox/quickjs";

const SYSTEM_PROMPT = `You are a code generator for Odyhook, a webhook management platform.

Users describe how they want to reshape a webhook payload before it's forwarded to a destination. You output a single JavaScript arrow function that takes the event payload and returns the transformed value.

Requirements:
- Output ONLY the function, no prose, no markdown code fences, no commentary.
- The function must be a pure arrow function with signature: (event) => transformed
- Use only built-ins: Object, Array, String, Number, Math, JSON, Date. No I/O, no fetch, no require, no imports.
- Be defensive: handle missing or null fields gracefully.
- Keep it short and readable. Prefer clarity over cleverness.
- Do NOT wrap in backticks or any other formatting.

Example input description: "Extract customer email and total in dollars"
Example input payload: {"customer":{"email":"a@b.com"},"amount_cents":2500}
Example output:
(event) => ({
  email: event?.customer?.email ?? null,
  totalDollars: (event?.amount_cents ?? 0) / 100
})`;

export type GeneratedTransform = {
  codeJs: string;
  previewOk: boolean;
  previewOutput: unknown;
  previewError: string | null;
};

/**
 * Ask Claude to generate a transformation function from a natural-language prompt
 * and a sample event. Immediately runs the generated code against the sample in
 * the sandbox and returns both the code and the preview result.
 */
export async function generateTransformation(
  userId: string,
  prompt: string,
  sampleEvent: unknown,
): Promise<GeneratedTransform> {
  const llm = await llmFor(userId);

  const userMessage = [
    `Target shape (plain English): ${prompt}`,
    ``,
    `Sample input payload:`,
    "```json",
    JSON.stringify(sampleEvent, null, 2).slice(0, 6000),
    "```",
    ``,
    `Return only the arrow function, nothing else.`,
  ].join("\n");

  const { text } = await llm.complete({
    tier: "standard",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  let codeJs = text.trim();

  // Defensive: strip markdown fences if Claude added them anyway.
  if (codeJs.startsWith("```")) {
    codeJs = codeJs
      .replace(/^```(?:js|javascript|typescript|ts)?\n/, "")
      .replace(/\n```$/, "")
      .trim();
  }

  // Preview against the sample in the sandbox.
  const result = await runTransformation(codeJs, sampleEvent);

  return {
    codeJs,
    previewOk: result.ok,
    previewOutput: result.ok ? result.value : null,
    previewError: result.ok ? null : result.error,
  };
}
