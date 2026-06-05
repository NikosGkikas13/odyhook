// Per-account resource quotas.
//
// Creation paths enforced no upper bound on sources / destinations / routes /
// API tokens, so one authenticated account could script unbounded growth of DB
// rows (and, via fan-out, deliveries + queue jobs) in this multi-tenant service.
// assertWithinQuota is called from each create path and throws
// QuotaExceededError, which callers map to HTTP 409 (REST) / a tool error (MCP).
//
// Limits are configurable via env; defaults are generous for real use but cap
// abuse. Routes are owned transitively (route -> source -> user).

import { prisma } from "@/lib/prisma";

export type QuotaResource = "sources" | "destinations" | "routes" | "apiTokens";

/** Thrown when a create would exceed the account's limit. Maps to 409. */
export class QuotaExceededError extends Error {
  constructor(
    public readonly resource: QuotaResource,
    public readonly limit: number,
  ) {
    super(`account limit reached: at most ${limit} ${resource} per account`);
    this.name = "QuotaExceededError";
  }
}

function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export function quotaLimit(resource: QuotaResource): number {
  switch (resource) {
    case "sources":
      return envInt("MAX_SOURCES_PER_USER", 100);
    case "destinations":
      return envInt("MAX_DESTINATIONS_PER_USER", 100);
    case "routes":
      return envInt("MAX_ROUTES_PER_USER", 200);
    case "apiTokens":
      return envInt("MAX_API_TOKENS_PER_USER", 25);
  }
}

function countFor(userId: string, resource: QuotaResource): Promise<number> {
  switch (resource) {
    case "sources":
      return prisma.source.count({ where: { userId } });
    case "destinations":
      return prisma.destination.count({ where: { userId } });
    case "routes":
      // Routes have no userId column; ownership is via the parent source.
      return prisma.route.count({ where: { source: { userId } } });
    case "apiTokens":
      // Count live tokens only — revoked ones don't grant access, and this
      // lets a user rotate without permanently consuming the budget.
      return prisma.apiToken.count({ where: { userId, revokedAt: null } });
  }
}

/** Throw QuotaExceededError if the user is already at the limit for `resource`. */
export async function assertWithinQuota(
  userId: string,
  resource: QuotaResource,
): Promise<void> {
  const limit = quotaLimit(resource);
  const count = await countFor(userId, resource);
  if (count >= limit) throw new QuotaExceededError(resource, limit);
}
