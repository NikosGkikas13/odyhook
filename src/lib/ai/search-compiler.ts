import type { LlmClient } from "@/lib/llm";
import { extractJsonText } from "./json";
import { validateEventQuery, type EventQuery, type SourceRef } from "@/lib/search/types";
import { describeEventQuery } from "@/lib/search/describe";

export class SearchCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchCompileError";
  }
}

const SYSTEM_PROMPT = `You translate a plain-English event-search request into a single JSON object that filters webhook events. Output ONLY the JSON — no prose, no markdown fences.

Shape:
{
  "metadata": {
    "sourceId": string | null,        // pick from the provided sources, or null for all
    "receivedAfter": string | null,   // ISO 8601 UTC, inclusive lower bound
    "receivedBefore": string | null,  // ISO 8601 UTC, exclusive upper bound
    "status": string[] | null         // any of: pending, in_flight, delivered, failed, exhausted
  },
  "payload": <filter AST> | null       // matches against the JSON request body
}

Time:
- Resolve every relative time expression to an absolute receivedAfter/receivedBefore range using the provided "now" and timezone. Output timestamps in UTC ("Z").
- "yesterday" = the previous calendar day [00:00, next 00:00). "last 24h"/"last day" = now-24h to null. "since Monday" = that day 00:00 to null. "in May" = that month's [1st, next 1st).

Status:
- "failed"/"failures" usually means ["failed","exhausted"]. "delivered"/"successful" = ["delivered"].

Payload filter AST grammar (matches fields inside the JSON body; paths are JSONPath-lite starting with "$."):
  { "and": [node, ...] } | { "or": [node, ...] } | { "not": node }
  { "eq": ["$.path", literal] } | { "neq": ["$.path", literal] }
  { "gt"|"gte"|"lt"|"lte": ["$.path", number] }
  { "in": ["$.path", [literal, ...]] }
  { "contains": ["$.path", "substring"] }
  { "startsWith": ["$.path", "prefix"] } | { "endsWith": ["$.path", "suffix"] }
  { "exists": "$.path" }
Rules:
- Use payload: null when the request only constrains source/time/status.
- Ground payload paths in the provided sample bodies; do not invent fields.
- The payload root must be a single node (commonly an "and").`;

export type CompileSearchArgs = {
  llm: LlmClient;
  prompt: string;
  sources: SourceRef[];
  sampleBodies: string[];
  now?: Date;
  timeZone?: string;
};

export async function compileSearchQuery(
  args: CompileSearchArgs,
): Promise<{ query: EventQuery; summary: string[] }> {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? "UTC";

  const userMessage = [
    `Now: ${now.toISOString()}`,
    `Timezone: ${timeZone}`,
    ``,
    `Sources (resolve a named source to its id):`,
    JSON.stringify(args.sources.map((s) => ({ id: s.id, name: s.name, slug: s.slug }))),
    ``,
    `Recent sample event bodies (for grounding payload paths):`,
    "```json",
    JSON.stringify(args.sampleBodies.slice(0, 20)).slice(0, 6000),
    "```",
    ``,
    `Request: ${args.prompt}`,
    ``,
    `Return ONLY the JSON object.`,
  ].join("\n");

  const { text } = await args.llm.complete({
    tier: "standard",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    throw new SearchCompileError("could not interpret the search: model did not return JSON");
  }

  let query: EventQuery;
  try {
    query = validateEventQuery(parsed);
  } catch (e) {
    throw new SearchCompileError(
      `could not interpret the search: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Never trust the model's source id — coerce anything not owned by the caller to null.
  if (query.metadata.sourceId && !args.sources.some((s) => s.id === query.metadata.sourceId)) {
    query = { ...query, metadata: { ...query.metadata, sourceId: null } };
  }

  return { query, summary: describeEventQuery(query, args.sources) };
}
