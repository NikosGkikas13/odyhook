// Origin-based CSRF defense for cookie-authenticated, state-changing routes.
//
// Server Actions get framework CSRF protection, but the hand-rolled
// session-authed POST handlers (replay, bulk-replay, bulk-cancel) rely only on
// the cookie's SameSite=Lax default — implicit and brittle (a SameSite change
// or a same-site subdomain XSS removes it). This adds an explicit check:
// the request's Origin (or, failing that, Referer) must match an allowed app
// origin. Browsers send Origin on state-changing requests, so a missing one on
// these routes is treated as untrusted.

function appOrigins(): string[] {
  const out = new Set<string>();
  for (const v of [process.env.AUTH_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    if (!v) continue;
    try {
      out.add(new URL(v).origin);
    } catch {
      /* ignore malformed env */
    }
  }
  return [...out];
}

function candidateOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True if the request looks same-origin. The allow-list is the configured app
 * origin(s) plus the request's own URL origin — the latter covers same-origin
 * requests regardless of whether the reverse proxy preserves the public Host.
 */
export function isAllowedOrigin(req: Request): boolean {
  const candidate = candidateOrigin(req);
  if (!candidate) return false;
  const allowed = new Set(appOrigins());
  try {
    allowed.add(new URL(req.url).origin);
  } catch {
    /* req.url should always parse */
  }
  return allowed.has(candidate);
}
