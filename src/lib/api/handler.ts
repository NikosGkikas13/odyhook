// src/lib/api/handler.ts
import { z } from "zod";

import { authenticateApiToken, type ApiAuth } from "./authenticate";
import { checkApiRateLimit } from "@/lib/ratelimit";
import { apiError, rateLimited, type ErrorCode } from "./respond";
import { RouteConflictError } from "@/lib/services/routes";
import { QuotaExceededError } from "@/lib/quota";
import { readJsonLimited, BodyTooLargeError } from "./body";

type Handler = (req: Request, auth: ApiAuth, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/**
 * Authenticate, rate-limit, then run `fn`. Centralizes 401/429 and maps
 * thrown ZodError → 400 validation_error, "not found" → 404,
 * RouteConflictError → 409, SSRF/header validation Errors → 400, everything
 * else → rethrow (500 via framework).
 */
export function withApiAuth(fn: Handler) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const auth = await authenticateApiToken(req);
    if (!auth) return apiError("unauthorized", "missing or invalid API token");

    try {
      const rl = await checkApiRateLimit(auth.tokenId);
      if (!rl.allowed) return rateLimited(Math.max(1, Math.ceil(rl.retryAfterMs / 1000)));
    } catch (err) {
      // Fail open on Redis errors, matching ingest/replay behavior.
      console.error("[api] rate limiter error (failing open):", err);
    }

    try {
      return await fn(req, auth, ctx);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return apiError("payload_too_large", "request body too large");
      }
      if (err instanceof z.ZodError) {
        return apiError("validation_error", "request validation failed", { issues: err.issues });
      }
      if (err instanceof RouteConflictError) {
        return apiError("conflict", err.message);
      }
      if (err instanceof QuotaExceededError) {
        return apiError("conflict", err.message);
      }
      if (
        err instanceof Error &&
        (/^Destination URL rejected:/.test(err.message) || /^Invalid header/.test(err.message))
      ) {
        return apiError("validation_error", err.message);
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        return apiError("not_found", err.message);
      }
      // Catch-all: log server-side and return a generic JSON 500 so behavior is
      // explicit regardless of runtime mode (no framework dev-error detail leak).
      console.error("[api] unhandled error:", err);
      return apiError("server_error", "internal server error");
    }
  };
}

/**
 * Parse a size-limited JSON request body. A `BodyTooLargeError` propagates so
 * withApiAuth can map it to 413; any other failure (missing/malformed body)
 * becomes a ZodError → 400 validation_error, preserving prior behavior.
 */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await readJsonLimited(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    throw new z.ZodError([{ code: "custom", path: [], message: "invalid JSON body" }]);
  }
}

export { apiError };
export type { ErrorCode };
