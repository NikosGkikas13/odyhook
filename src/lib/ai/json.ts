/**
 * Strip Markdown code-fences (```` ``` ```` or ```` ```json ````) that a model
 * sometimes wraps JSON in, returning the inner text trimmed. Does NOT validate
 * that the result is JSON — the caller runs JSON.parse and handles failure.
 */
export function extractJsonText(text: string): string {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw
      .replace(/^```(?:json)?\r?\n/, "")
      .replace(/\r?\n?```$/, "")
      .trim();
  }
  return raw;
}
