import { NextResponse } from "next/server";
import { z } from "zod";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { NoUserApiKeyError } from "@/lib/anthropic";
import { searchEvents } from "@/lib/services/search";
import { SearchCompileError } from "@/lib/ai/search-compiler";

export const runtime = "nodejs";

const SearchInput = z.object({
  q: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const POST = withApiAuth(async (req, auth) => {
  const { q, cursor, limit } = SearchInput.parse(await readJson(req));

  try {
    const r = await searchEvents(auth.userId, q, { cursor, limit });
    return NextResponse.json({
      query: r.query,
      summary: r.summary,
      events: r.events.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        method: e.method,
        receivedAt: e.receivedAt.toISOString(),
        remoteIp: e.remoteIp,
        idempotencyKey: e.idempotencyKey,
      })),
      scanned: r.scanned,
      scanCapped: r.scanCapped,
      nextCursor: r.nextCursor,
    });
  } catch (err) {
    // BYOK-missing and uninterpretable queries are user-facing 400s. Anything
    // else (Anthropic network/SDK errors) rethrows → 500 via withApiAuth.
    if (err instanceof NoUserApiKeyError) {
      return apiError("validation_error", "No Anthropic API key configured (set one in Settings → API Keys).");
    }
    if (err instanceof SearchCompileError) {
      return apiError("validation_error", "Could not interpret the search query. Try rephrasing.");
    }
    throw err;
  }
});
