import type Anthropic from "@anthropic-ai/sdk";

import { extractJsonText } from "./json";
import { MODEL_CHEAP } from "./models";

/** Thrown when the model's output can't be used as a diff (a user-facing,
 *  not infrastructure, failure). The action maps this to an inline error. */
export class EventDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDiffError";
  }
}

export type DiffChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  from?: string;
  to?: string;
};

export type DiffResult = {
  summary: string;
  changes: DiffChange[];
  modelUsed: string;
};

/** Cap each payload before embedding it in the prompt. ~6 KB each keeps the
 *  combined context bounded; webhook bodies above this are rare and a prefix
 *  is enough for a structural explanation. */
export const MAX_BODY_CHARS = 6000;

const SYSTEM_PROMPT = `You compare two webhook payloads (an older "A" and a newer "B") and explain, in plain English, what changed from A to B.

Respond with STRICT JSON only — no prose, no markdown, no code fences:
  { "summary": string, "changes": { "path": string, "kind": "added"|"removed"|"changed", "from"?: string, "to"?: string }[] }

- "summary" is one short plain-English sentence describing the overall change. If the two payloads are unrelated (different event shapes entirely), say so in the summary.
- "changes" lists concrete field-level differences. "path" is a JSONPath-lite string ("$.data.object.amount").
- "kind" is "added" (only in B), "removed" (only in A), or "changed" (different value).
- "from"/"to" are the stringified scalar values. Omit "from" for added fields and "to" for removed fields. For object/array values, give a brief summary string rather than dumping the whole structure.
- Report only meaningful differences; ignore values that are equal.`;

/** Pretty-print a JSON body for the prompt, falling back to the raw text, then
 *  cap it. Returns a string safe to embed in a fenced block. */
function prepBody(raw: string): string {
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // non-JSON body: send the raw text as-is
  }
  return pretty.slice(0, MAX_BODY_CHARS);
}

export type ExplainEventDiffOpts = {
  anthropic: Anthropic;
  /** Older payload (raw request body as text). */
  bodyA: string;
  /** Newer payload (raw request body as text). */
  bodyB: string;
};

/**
 * Ask Claude to explain what changed from payload A (older) to payload B
 * (newer). Returns a structured diff. Throws EventDiffError if the model does
 * not return valid JSON.
 *
 * Trust boundary: the payload bodies are the user's own webhook data — already
 * shown to them in the dashboard — sent to their own BYOK Anthropic key. We cap
 * size but do not otherwise scrub; worst case is a less-useful explanation, not
 * code execution.
 */
export async function explainEventDiff(
  opts: ExplainEventDiffOpts,
): Promise<DiffResult> {
  const { anthropic, bodyA, bodyB } = opts;

  const content = [
    "Payload A (older):",
    "```json",
    prepBody(bodyA),
    "```",
    "",
    "Payload B (newer):",
    "```json",
    prepBody(bodyB),
    "```",
    "",
    "Output ONLY the JSON object describing what changed from A to B.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL_CHEAP,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new EventDiffError("the model did not return a usable response");
  }

  const raw = extractJsonText(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EventDiffError(
      "the model did not return valid JSON — try again",
    );
  }

  // Fix 1: JSON.parse("null") / "123" / etc. succeeds but yields a non-object.
  // Surface a clean EventDiffError instead of a downstream TypeError.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EventDiffError("the model did not return valid JSON — try again");
  }

  const p = parsed as { summary?: unknown; changes?: unknown };
  // Fix 2: null / primitive items inside the changes array would crash .map.
  // Fix 3: enforce the from/to contract — drop the semantically-invalid side.
  const changes: DiffChange[] = Array.isArray(p.changes)
    ? p.changes
        .filter(
          (c): c is Record<string, unknown> =>
            c !== null && typeof c === "object",
        )
        .map((c) => {
          const ch = c as Record<string, unknown>;
          const kind =
            ch.kind === "added" || ch.kind === "removed" ? ch.kind : "changed";
          return {
            path: String(ch.path ?? ""),
            kind,
            ...(ch.from !== undefined && kind !== "added"
              ? { from: String(ch.from) }
              : {}),
            ...(ch.to !== undefined && kind !== "removed"
              ? { to: String(ch.to) }
              : {}),
          };
        })
    : [];

  return {
    summary: String(p.summary ?? ""),
    changes,
    modelUsed: response.model,
  };
}

/** Given two events, return their ids ordered older→newer by receivedAt. Ties
 *  (equal timestamps) fall back to id ordering for a stable cache key. */
export function canonicalPair(
  a: { id: string; receivedAt: Date },
  b: { id: string; receivedAt: Date },
): { olderId: string; newerId: string } {
  const aFirst =
    a.receivedAt.getTime() < b.receivedAt.getTime() ||
    (a.receivedAt.getTime() === b.receivedAt.getTime() && a.id < b.id);
  return aFirst
    ? { olderId: a.id, newerId: b.id }
    : { olderId: b.id, newerId: a.id };
}
