// Hardened outbound fetch for attacker-influenced URLs (delivery destinations,
// alert webhooks). It closes the two SSRF-guard bypasses that plain
// `fetch(url)` leaves open even after an `assertSafeUrl` pre-check:
//
//   1. HTTP redirect bypass — default `fetch` follows 3xx anywhere, including
//      to internal hosts the guard never saw. We use `redirect: "manual"` so a
//      redirect is returned verbatim and never transparently followed.
//
//   2. DNS-rebinding TOCTOU — the guard's `dns.lookup` and `fetch`'s own lookup
//      are distinct resolutions; a low-TTL attacker domain can answer "public"
//      to one and "private" to the other. We resolve+validate ONCE (resolveSafe)
//      and pin the socket to that exact validated IP via a per-request undici
//      Agent, so the address the guard approved is the address we connect to.
//      The original hostname is still used for the Host header and TLS SNI.
//
// Egress firewalling on the worker host is the recommended defense-in-depth
// layer beneath this (see SECURITY_AUDIT.md).

import net, { type LookupFunction } from "node:net";
import { fetch, Agent, type Response as UndiciResponse } from "undici";

import { resolveSafe } from "./ssrf";

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  /** WHATWG-compatible response (undici). Body is unread — caller reads it. */
  res: UndiciResponse;
  /** Releases the pinned connection. Call after the body is consumed. */
  close: () => Promise<void>;
}

// dns.lookup-compatible function that always yields `ip`, ignoring the requested
// hostname. Handed to undici's connect step so the TCP socket goes to the
// pre-validated address and cannot be re-pointed by a second DNS answer.
export function pinnedLookup(ip: string): LookupFunction {
  const family = net.isIPv6(ip) ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: ip, family }]);
    else callback(null, ip, family);
  };
}

/**
 * Read at most `cap` bytes of a response body, then cancel the rest.
 *
 * `res.text()` buffers the ENTIRE body — the request timeout bounds time, not
 * bytes, so a destination on a fat pipe can stream gigabytes within the window
 * and OOM the worker. Since callers only keep a short snippet, we read just past
 * `cap` (one network chunk at a time) and abort the upload. Returns the decoded
 * text sliced to `cap`.
 */
// Minimal byte-stream shape common to a DOM `ReadableStream` and node's
// `stream/web` one (undici response bodies are the latter; the two are
// nominally incompatible in TS). We only need getReader().read()/cancel().
interface ReadableByteBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  };
}

export async function readCappedText(
  body: ReadableByteBody | null,
  cap: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    // Stop the transfer instead of draining the (possibly huge) remainder.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, cap);
}

/**
 * Resolve + validate `rawUrl`, then fetch it pinned to the validated IP with
 * redirects disabled. Throws `SsrfError` (from resolveSafe) if the target is a
 * blocked address; the caller treats that as a terminal, non-retryable failure.
 *
 * `opts.resolve` is injectable purely for tests; production uses `resolveSafe`.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchInit = {},
  opts: { resolve?: typeof resolveSafe } = {},
): Promise<SafeFetchResult> {
  const resolve = opts.resolve ?? resolveSafe;
  const { url, ips } = await resolve(rawUrl);

  const agent = new Agent({ connect: { lookup: pinnedLookup(ips[0]) } });
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: "manual",
      dispatcher: agent,
    });
    return { res, close: () => agent.close() };
  } catch (err) {
    await agent.close().catch(() => {});
    throw err;
  }
}
