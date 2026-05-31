export type EventPayload = {
  id: string;
  method: string;
  headersJson: Record<string, string>;
  bodyRaw: string;
  receivedAt: string;
};

export type ForwardResult =
  | { ok: true; status: number; ms: number }
  | { ok: false; error: string; ms: number };

// Headers that describe the prior hop, not the message. The HTTP client
// recomputes host/content-length and manages the connection itself.
const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

export function filterHeaders(
  h: Record<string, string> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Re-POST one captured event to a local URL. Never throws. */
export async function forwardEvent(
  event: EventPayload,
  forwardUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ForwardResult> {
  const start = Date.now();
  try {
    const res = await fetchImpl(forwardUrl, {
      method: event.method,
      headers: filterHeaders(event.headersJson),
      body: event.method === "GET" || event.method === "HEAD" ? undefined : event.bodyRaw,
    });
    return { ok: true, status: res.status, ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    };
  }
}
