import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";

import { prisma } from "@/lib/prisma";
import { assertWithinQuota } from "@/lib/quota";
import type { Page } from "@/lib/api/respond";

export const routeCreateSchema = z.object({
  sourceId: z.string().min(1),
  destinationId: z.string().min(1),
  enabled: z.boolean().default(true),
});

export const routeUpdateSchema = z.object({
  enabled: z.boolean().optional(),
});

export type RouteInput = z.input<typeof routeCreateSchema>;
export type RouteUpdateInput = z.input<typeof routeUpdateSchema>;

export type RouteDTO = {
  id: string;
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  hasFilter: boolean;
  createdAt: string;
};

type RouteRow = {
  id: string;
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  filterAst: unknown;
  createdAt: Date;
};

function toDTO(r: RouteRow): RouteDTO {
  return {
    id: r.id,
    sourceId: r.sourceId,
    destinationId: r.destinationId,
    enabled: r.enabled,
    hasFilter: r.filterAst != null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Thrown when a (source,destination) route already exists. Handlers map to 409. */
export class RouteConflictError extends Error {}

export async function createRoute(userId: string, input: RouteInput): Promise<RouteDTO> {
  const parsed = routeCreateSchema.parse(input);
  // Both ends must belong to the caller.
  const [source, destination] = await Promise.all([
    prisma.source.findFirst({ where: { id: parsed.sourceId, userId } }),
    prisma.destination.findFirst({ where: { id: parsed.destinationId, userId } }),
  ]);
  if (!source || !destination) throw new Error("not found");
  await assertWithinQuota(userId, "routes");

  const existing = await prisma.route.findUnique({
    where: { sourceId_destinationId: { sourceId: parsed.sourceId, destinationId: parsed.destinationId } },
  });
  if (existing) throw new RouteConflictError("conflict: route already exists");

  // The findUnique above handles the common case cleanly, but two concurrent
  // creates can both pass it and race to insert. The @@unique constraint is
  // the real guard: catch its P2002 and map to the same conflict error so the
  // handler returns 409 rather than 500. (Duck-typed like the ingest handler.)
  try {
    const created = await prisma.route.create({
      data: { sourceId: parsed.sourceId, destinationId: parsed.destinationId, enabled: parsed.enabled },
    });
    return toDTO(created);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "P2002") {
      throw new RouteConflictError("conflict: route already exists");
    }
    throw err;
  }
}

export async function listRoutes(
  userId: string,
  page: Page,
): Promise<{ data: RouteDTO[]; nextCursor: string | null }> {
  const rows = await prisma.route.findMany({
    where: { source: { userId } },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getRoute(userId: string, id: string): Promise<RouteDTO | null> {
  const row = await prisma.route.findFirst({ where: { id, source: { userId } } });
  return row ? toDTO(row) : null;
}

export async function updateRoute(
  userId: string,
  id: string,
  input: RouteUpdateInput,
): Promise<RouteDTO | null> {
  const parsed = routeUpdateSchema.parse(input);
  const existing = await prisma.route.findFirst({ where: { id, source: { userId } } });
  if (!existing) return null;
  const data: Record<string, unknown> = {};
  if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
  if (Object.keys(data).length === 0) {
    return toDTO(existing);
  }
  const updated = await prisma.route.update({ where: { id }, data });
  return toDTO(updated);
}

export async function deleteRoute(userId: string, id: string): Promise<boolean> {
  const existing = await prisma.route.findFirst({ where: { id, source: { userId } }, select: { id: true } });
  if (!existing) return false;
  await prisma.route.delete({ where: { id } });
  return true;
}

/** Persist (set or replace) a route's filter AST. Returns false if the route isn't the user's. */
export async function setRouteFilter(
  userId: string,
  routeId: string,
  ast: FilterAst,
  prompt?: string | null,
): Promise<boolean> {
  const existing = await prisma.route.findFirst({
    where: { id: routeId, source: { userId } },
    select: { id: true },
  });
  if (!existing) return false;
  const validated = validateFilterAst(ast);
  await prisma.route.update({
    where: { id: routeId },
    data: { filterAst: validated as unknown as object, filterPrompt: prompt ?? null },
  });
  return true;
}

/** Remove a route's filter. Returns false if the route isn't the user's. */
export async function clearRouteFilter(userId: string, routeId: string): Promise<boolean> {
  const existing = await prisma.route.findFirst({
    where: { id: routeId, source: { userId } },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.route.update({
    where: { id: routeId },
    data: { filterAst: Prisma.DbNull, filterPrompt: null },
  });
  return true;
}
