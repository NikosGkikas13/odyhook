import { llmFor } from "@/lib/llm";
import {
  validateFilterAst,
  evaluateFilter,
  type FilterAst,
} from "@/lib/filters/evaluator";
import { extractJsonText } from "./json";

// Turn a plain-English routing rule into a deterministic filter AST.
// The AST is evaluated at delivery time (see filters/evaluator.ts) — Claude is
// only used to author the rule, not to run it.

const SYSTEM_PROMPT = `You compile plain-English webhook routing rules into a small JSON filter AST.

Grammar:
  { "and":  [node, node, ...] }
  { "or":   [node, node, ...] }
  { "not":  node }
  { "eq":   ["$.path.to.field", literal] }
  { "neq":  ["$.path.to.field", literal] }
  { "gt":   ["$.path.to.field", number] }
  { "gte":  ["$.path.to.field", number] }
  { "lt":   ["$.path.to.field", number] }
  { "lte":  ["$.path.to.field", number] }
  { "in":   ["$.path.to.field", [literal, literal, ...]] }
  { "contains": ["$.path.to.field", "substring"] }
  { "startsWith": ["$.path.to.field", "prefix"] }
  { "endsWith":   ["$.path.to.field", "suffix"] }
  { "exists": "$.path.to.field" }

Rules:
- Paths use JSONPath-lite: start with "$.", dot-separated keys only.
- Amounts in webhook payloads (Stripe, etc.) are usually in the smallest currency unit (cents). If the user says "> $1000" interpret that as "> 100000" on "$.data.object.amount" unless context strongly suggests otherwise.
- If the user provides a sample event, ground your paths in that sample's structure.
- Output ONLY the JSON AST — no prose, no markdown, no code fences.
- Do not invent fields not present in the sample. If a field is ambiguous, pick the most canonical path for the given provider.
- The root must be a single node (commonly an "and" wrapping multiple conditions).`;

export type CompiledRule = {
  ast: FilterAst;
  matchedCount: number;
  totalCount: number;
  sampleMatches: unknown[];
};

/**
 * Ask Claude to compile a natural-language rule against a recent sample of
 * events, then validate the AST and run it against the samples to produce a
 * match count for the UI's sanity check.
 */
export async function compileRule(
  userId: string,
  prompt: string,
  sampleEvents: unknown[],
): Promise<CompiledRule> {
  const llm = await llmFor(userId);

  const userMessage = [
    `Rule: ${prompt}`,
    ``,
    `Recent sample events (${sampleEvents.length}):`,
    "```json",
    JSON.stringify(sampleEvents.slice(0, 5), null, 2).slice(0, 6000),
    "```",
    ``,
    `Compile this rule to a filter AST. Return ONLY the JSON.`,
  ].join("\n");

  const { text } = await llm.complete({
    tier: "standard",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const raw = extractJsonText(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Claude did not return valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const ast = validateFilterAst(parsed);

  // Count matches against the provided samples for the UI sanity-check.
  const matches = sampleEvents.filter((ev) => {
    try {
      return evaluateFilter(ast, ev);
    } catch {
      return false;
    }
  });

  return {
    ast,
    matchedCount: matches.length,
    totalCount: sampleEvents.length,
    sampleMatches: matches.slice(0, 3),
  };
}
