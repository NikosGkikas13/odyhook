import type { Config } from "./config.js";

/** Build an absolute URL against the configured host. */
export function apiUrl(cfg: Config, path: string): string {
  return `${cfg.host.replace(/\/+$/, "")}${path}`;
}

/** Authorization header for the configured token. */
export function authHeaders(cfg: Config): Record<string, string> {
  return { authorization: `Bearer ${cfg.token}` };
}

type SourceLite = { id: string; slug: string };

/** Resolve a source slug to its id by paging /api/v1/sources. */
export async function resolveSourceId(
  cfg: Config,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let cursor: string | null = null;
  do {
    const u = new URL(apiUrl(cfg, "/api/v1/sources"));
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetchImpl(u.toString(), { headers: authHeaders(cfg) });
    if (res.status === 401) throw new Error("token rejected; re-run `ody login`");
    if (!res.ok) throw new Error(`failed to list sources (HTTP ${res.status})`);
    const body = (await res.json()) as { data: SourceLite[]; nextCursor: string | null };
    const hit = body.data.find((s) => s.slug === slug);
    if (hit) return hit.id;
    cursor = body.nextCursor;
  } while (cursor);
  throw new Error(`source not found: ${slug}`);
}
