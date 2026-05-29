import { NextResponse } from "next/server";

export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "conflict";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  validation_error: 400,
  rate_limited: 429,
  conflict: 409,
};

export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status: STATUS[code] },
  );
}

/** 429 with a Retry-After hint (seconds). */
export function rateLimited(retryAfterSec: number) {
  return NextResponse.json(
    { error: { code: "rate_limited", message: "rate limit exceeded" } },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec), "X-RateLimit-Remaining": "0" },
    },
  );
}

export type Page = { limit: number; cursor: string | null };

/** Read `?limit=` (default 25, clamped 1..100) and `?cursor=` from a URL. */
export function parsePage(url: URL): Page {
  const rawLimit = Number(url.searchParams.get("limit") ?? 25);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
    : 25;
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor: cursor && cursor.length > 0 ? cursor : null };
}
