import { prisma } from "@/lib/prisma";
import { anthropicFor } from "@/lib/anthropic";
import { compileSearchQuery } from "@/lib/ai/search-compiler";
import { runEventSearch, type RunSearchResult } from "@/lib/search/run";
import type { EventQuery, SourceRef } from "@/lib/search/types";

const SAMPLE_BODIES = 20;

export type SearchContext = { sources: SourceRef[]; sampleBodies: string[] };

/** Load the data Claude needs to ground a search: the user's sources and a
 *  sample of their most recent event bodies (across all sources). */
export async function loadSearchContext(userId: string): Promise<SearchContext> {
  const [sources, recent] = await Promise.all([
    prisma.source.findMany({
      where: { userId },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    }),
    prisma.event.findMany({
      where: { source: { userId } },
      orderBy: { receivedAt: "desc" },
      take: SAMPLE_BODIES,
      select: { bodyRaw: true },
    }),
  ]);
  return { sources, sampleBodies: recent.map((e) => e.bodyRaw) };
}

export type CompileOpts = { now?: Date; timeZone?: string };

/** Compile an NL prompt into a validated EventQuery using the user's BYOK key.
 *  Throws NoUserApiKeyError if unset, SearchCompileError on bad model output. */
export async function compileSearchForUser(
  userId: string,
  prompt: string,
  opts: CompileOpts = {},
): Promise<{ query: EventQuery; summary: string[] }> {
  const [anthropic, ctx] = await Promise.all([
    anthropicFor(userId),
    loadSearchContext(userId),
  ]);
  return compileSearchQuery({
    anthropic,
    prompt,
    sources: ctx.sources,
    sampleBodies: ctx.sampleBodies,
    now: opts.now,
    timeZone: opts.timeZone,
  });
}

export type SearchOpts = CompileOpts & { limit?: number; cursor?: string | null };

/** Compile + run in one call (REST API and MCP). */
export async function searchEvents(
  userId: string,
  prompt: string,
  opts: SearchOpts = {},
): Promise<{ query: EventQuery; summary: string[] } & RunSearchResult> {
  const { query, summary } = await compileSearchForUser(userId, prompt, {
    now: opts.now,
    timeZone: opts.timeZone,
  });
  const result = await runEventSearch(userId, query, { limit: opts.limit, cursor: opts.cursor });
  return { query, summary, ...result };
}
