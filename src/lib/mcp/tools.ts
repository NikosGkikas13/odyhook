import { z } from "zod";

import {
  listSources, getSource, createSource, updateSource,
  sourceCreateSchema, sourceUpdateSchema,
} from "@/lib/services/sources";
import {
  listDestinations, getDestination, createDestination, updateDestination,
  destinationCreateSchema, destinationUpdateSchema,
} from "@/lib/services/destinations";
import {
  listRoutes, getRoute, createRoute, updateRoute,
  setRouteFilter, clearRouteFilter, routeCreateSchema,
} from "@/lib/services/routes";
import { listEvents, getEvent } from "@/lib/services/events";
import { listDeliveries } from "@/lib/services/deliveries";
import { compileFilterForSource } from "@/lib/services/filters";
import { validateFilterAst } from "@/lib/filters/evaluator";
import type { Page } from "@/lib/api/respond";

export type ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: S;
  handler: (userId: string, input: z.infer<S>) => Promise<unknown>;
};

function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

function orNotFound<T>(x: T | null): T {
  if (x == null) throw new Error("not found");
  return x;
}

function toPage(input: { limit?: number; cursor?: string }): Page {
  return { limit: input.limit ?? 25, cursor: input.cursor ?? null };
}

function validateAstOrThrow(value: unknown) {
  try {
    return validateFilterAst(value);
  } catch (e) {
    throw new Error(`invalid filter AST: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const pageShape = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};
const idSchema = z.object({ id: z.string().min(1) });
const DELIVERY_STATUSES = ["pending", "in_flight", "delivered", "failed", "exhausted"] as const;

export const tools: ToolDef[] = [
  // ---------- Reads ----------
  defineTool({
    name: "list_sources",
    description: "List the caller's webhook sources (id, name, slug, verifyStyle). To find Stripe sources, look for verifyStyle === 'stripe'.",
    inputSchema: z.object({ ...pageShape }),
    handler: (u, i) => listSources(u, toPage(i)),
  }),
  defineTool({
    name: "get_source",
    description: "Get one source by id.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getSource(u, i.id)),
  }),
  defineTool({
    name: "list_destinations",
    description: "List destinations (includes enabled, consecutiveFailures, autoDisabledAt).",
    inputSchema: z.object({ ...pageShape }),
    handler: (u, i) => listDestinations(u, toPage(i)),
  }),
  defineTool({
    name: "get_destination",
    description: "Get one destination by id.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getDestination(u, i.id)),
  }),
  defineTool({
    name: "list_routes",
    description: "List routes (source→destination links; hasFilter indicates a filter is attached).",
    inputSchema: z.object({ ...pageShape }),
    handler: (u, i) => listRoutes(u, toPage(i)),
  }),
  defineTool({
    name: "get_route",
    description: "Get one route by id.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getRoute(u, i.id)),
  }),
  defineTool({
    name: "list_events",
    description: "List received webhook events, newest first. Optional filters: sourceId, since/until (ISO 8601 timestamps).",
    inputSchema: z.object({
      sourceId: z.string().optional(),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      ...pageShape,
    }),
    handler: (u, i) => listEvents(u, toPage(i), { sourceId: i.sourceId, since: i.since, until: i.until }),
  }),
  defineTool({
    name: "get_event",
    description: "Get one event by id, including raw body, headers, and all delivery attempts.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getEvent(u, i.id)),
  }),
  defineTool({
    name: "list_deliveries",
    description: "List delivery attempts, newest first. Filters: sourceId, destinationId, status (any of pending|in_flight|delivered|failed|exhausted), since/until (ISO 8601). For failures pass status: ['failed','exhausted'].",
    inputSchema: z.object({
      sourceId: z.string().optional(),
      destinationId: z.string().optional(),
      status: z.array(z.enum(DELIVERY_STATUSES)).optional(),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      ...pageShape,
    }),
    handler: (u, i) =>
      listDeliveries(
        u,
        { sourceId: i.sourceId, destinationId: i.destinationId, status: i.status, since: i.since, until: i.until },
        toPage(i),
      ),
  }),

  // ---------- Safe writes ----------
  defineTool({
    name: "create_source",
    description: "Create a webhook source. verifyStyle is one of none|stripe|github|generic-sha256; a signingSecret is required unless verifyStyle is none.",
    inputSchema: sourceCreateSchema,
    handler: (u, i) => createSource(u, i),
  }),
  defineTool({
    name: "update_source",
    description: "Update a source by id.",
    inputSchema: sourceUpdateSchema.extend({ id: z.string().min(1) }),
    handler: async (u, i) => {
      const { id, ...rest } = i;
      return orNotFound(await updateSource(u, id, rest));
    },
  }),
  defineTool({
    name: "create_destination",
    description: "Create a destination. headers is a 'Key: Value' string, one per line. outboundSecret (>=16 chars) enables HMAC signing of deliveries.",
    inputSchema: destinationCreateSchema,
    handler: (u, i) => createDestination(u, i),
  }),
  defineTool({
    name: "update_destination",
    description: "Update a destination by id. Set enabled:false to pause, enabled:true to resume (resume clears auto-disable state).",
    inputSchema: destinationUpdateSchema.extend({ id: z.string().min(1) }),
    handler: async (u, i) => {
      const { id, ...rest } = i;
      return orNotFound(await updateDestination(u, id, rest));
    },
  }),
  defineTool({
    name: "pause_destination",
    description: "Pause a destination by id (stops new and in-flight deliveries).",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await updateDestination(u, i.id, { enabled: false })),
  }),
  defineTool({
    name: "resume_destination",
    description: "Resume a paused or auto-disabled destination by id (clears circuit-breaker state).",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await updateDestination(u, i.id, { enabled: true })),
  }),
  defineTool({
    name: "create_route",
    description: "Create a route from a source to a destination. Optionally attach a structured filter AST (author one from plain English with compile_filter, or pass your own).",
    inputSchema: routeCreateSchema.extend({ filter: z.unknown().optional() }),
    handler: async (u, i) => {
      const { filter, ...routeInput } = i;
      const ast = filter !== undefined ? validateAstOrThrow(filter) : undefined;
      const route = await createRoute(u, routeInput);
      if (ast !== undefined) {
        const ok = await setRouteFilter(u, route.id, ast);
        if (!ok) throw new Error("route not found");
        return { ...route, hasFilter: true };
      }
      return route;
    },
  }),
  defineTool({
    name: "update_route",
    description: "Enable or disable a route (source→destination link) by id.",
    inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean().optional() }),
    handler: async (u, i) => {
      const { id, ...rest } = i;
      return orNotFound(await updateRoute(u, id, rest));
    },
  }),
  defineTool({
    name: "set_route_filter",
    description: "Attach or replace a structured filter AST on a route. The route forwards an event only when the filter matches.",
    inputSchema: z.object({ routeId: z.string().min(1), ast: z.unknown() }),
    handler: async (u, i) => {
      const ast = validateAstOrThrow(i.ast);
      const ok = await setRouteFilter(u, i.routeId, ast);
      if (!ok) throw new Error("route not found");
      return { ok: true };
    },
  }),
  defineTool({
    name: "clear_route_filter",
    description: "Remove the filter from a route so all events forward.",
    inputSchema: z.object({ routeId: z.string().min(1) }),
    handler: async (u, i) => {
      const ok = await clearRouteFilter(u, i.routeId);
      if (!ok) throw new Error("route not found");
      return { ok: true };
    },
  }),

  // ---------- BYOK ----------
  defineTool({
    name: "compile_filter",
    description: "Compile a plain-English routing rule into a filter AST, grounded on the source's recent events. Preview only — does NOT persist. Returns { ast, matchedCount, totalCount }. Requires the user's Anthropic key (Settings → API Keys). Call set_route_filter (or create_route's filter arg) to apply the result.",
    inputSchema: z.object({ sourceId: z.string().min(1), prompt: z.string().min(1) }),
    handler: (u, i) => compileFilterForSource(u, i.sourceId, i.prompt),
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
