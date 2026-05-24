/**
 * Pure validation for the bulk replay / bulk cancel endpoints.
 *
 * Keeps the route handlers thin: they're an auth check + this parse + a
 * Prisma call. The interesting branches (shape, length cap, dedupe) live
 * here so they're unit-testable without spinning up a request.
 */

export const BULK_MAX_IDS = 50;

export type ParseResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

export function parseBulkIds(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) {
    return { ok: false, error: "ids must be an array of strings" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "ids must contain at least one entry" };
  }
  for (const v of raw) {
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: "ids entries must be non-empty strings" };
    }
  }
  // Dedupe while preserving first-seen order. Callers may end up posting the
  // same id twice if a user double-clicks; we want one update per id.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of raw as string[]) {
    if (seen.has(v)) continue;
    seen.add(v);
    ids.push(v);
  }
  if (ids.length > BULK_MAX_IDS) {
    return { ok: false, error: `at most ${BULK_MAX_IDS} ids per request` };
  }
  return { ok: true, ids };
}
