// SSRF guard for outbound destination URLs.
//
// We refuse to fetch URLs whose host resolves to a private/loopback/link-local/
// multicast/reserved address. This prevents an authed user from pointing a
// destination at a cloud-metadata endpoint (169.254.169.254), an internal DB
// (10.0.0.0/8), or localhost services that the worker process can reach.
//
// Three entry points:
//   - parseSafeUrl(raw)    — sync: validates scheme, credentials, and IP literals.
//   - resolveSafe(raw)     — async: also resolves DNS, rejects private targets,
//                            and returns the validated IP(s) so the caller can
//                            *pin* the outbound connection to exactly those
//                            addresses (defeats DNS-rebinding TOCTOU — the IP the
//                            guard validated is the IP the socket connects to).
//   - assertSafeUrl(raw)   — async: resolveSafe but discards the IPs, for
//                            create-time validation where no fetch follows.
//
// All throw SsrfError on failure. Call resolveSafe/assertSafeUrl when you have an
// event loop available (server actions, the worker); call parseSafeUrl from
// places where DNS isn't reachable.

import { promises as dns } from "node:dns";
import net from "node:net";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// IPv4 ranges blocked from outbound delivery. Sources: RFC 1918, 5735, 6598,
// 6890. Anything that is not globally routable.
const PRIVATE_IPV4_RANGES: Array<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // RFC 6598 CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const x = Number(p);
    if (x < 0 || x > 255) return null;
    n = (n * 256) + x;
  }
  return n;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable -> reject
  if (n === 0xffffffff) return true; // 255.255.255.255 broadcast
  for (const [base, prefix] of PRIVATE_IPV4_RANGES) {
    const baseN = ipv4ToInt(base);
    if (baseN === null) continue;
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    if ((n & mask) === (baseN & mask)) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) — extract the IPv4 and recheck.
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped && net.isIPv4(mapped[1])) return isPrivateIPv4(mapped[1]);
  // Multicast ff00::/8
  if (lower.startsWith("ff")) return true;
  // Link-local fe80::/10  (fe80..febf)
  if (/^fe[89ab]/.test(lower)) return true;
  // Unique local fc00::/7  (fc00..fdff)
  if (/^f[cd]/.test(lower)) return true;
  // Discard prefix 100::/64
  if (/^0*100:/.test(lower)) return true;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unknown family -> reject
}

// Strip surrounding brackets (e.g. "[::1]" -> "::1") that Node's URL.hostname
// returns for IPv6 literals.
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

export function parseSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SsrfError(`scheme not allowed: ${url.protocol || "(empty)"}`);
  }
  if (url.username || url.password) {
    throw new SsrfError("URL must not contain credentials");
  }
  const host = stripBrackets(url.hostname);
  if (!host) throw new SsrfError("URL must have a host");
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new SsrfError(`destination IP is in a blocked range: ${host}`);
  }
  return url;
}

export async function resolveSafe(
  rawUrl: string,
): Promise<{ url: URL; ips: string[] }> {
  const url = parseSafeUrl(rawUrl);
  const host = stripBrackets(url.hostname);
  if (net.isIP(host)) {
    // parseSafeUrl already rejected private IP literals, so this host is safe.
    return { url, ips: [host] };
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SsrfError(`DNS lookup failed for ${host}: ${msg}`);
  }
  if (addresses.length === 0) {
    throw new SsrfError(`DNS returned no addresses for ${host}`);
  }
  // Reject if ANY returned address is private: a host that resolves to a mix of
  // public and private addresses (or flips between them) must not be reachable.
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new SsrfError(
        `destination ${host} resolves to blocked IP ${a.address}`,
      );
    }
  }
  return { url, ips: addresses.map((a) => a.address) };
}

export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  return (await resolveSafe(rawUrl)).url;
}
