import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { findTool, tools } from "./tools";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setupUserSource() {
  const user = await prisma.user.create({ data: { email: `${uniq("mcpt")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("mcpt-s"), verifyStyle: "stripe" } });
  return { user, source };
}

describe("mcp tool registry", () => {
  it("exposes the expected core tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_sources", "get_source", "list_deliveries", "list_events",
        "create_route", "set_route_filter", "compile_filter", "pause_destination",
        "search_events",
      ]),
    );
  });

  it("list_sources returns only the caller's sources", async () => {
    const { user, source } = await setupUserSource();
    const other = await setupUserSource();
    const res = (await findTool("list_sources")!.handler(user.id, { limit: 100 })) as { data: { id: string }[] };
    const ids = res.data.map((s) => s.id);
    expect(ids).toContain(source.id);
    expect(ids).not.toContain(other.source.id);
  });

  it("get_source throws not found for another user's source", async () => {
    const a = await setupUserSource();
    const b = await setupUserSource();
    await expect(findTool("get_source")!.handler(b.user.id, { id: a.source.id })).rejects.toThrow(/not found/i);
  });

  it("create_route attaches a filter when one is provided", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("mcpcr")}@test.local` } });
    const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("mcpcr-s") } });
    const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/h" } });

    const res = (await findTool("create_route")!.handler(user.id, {
      sourceId: source.id,
      destinationId: dest.id,
      filter: { eq: ["$.type", "payment"] },
    })) as { id: string; hasFilter: boolean };

    expect(res.hasFilter).toBe(true);
    const row = await prisma.route.findUnique({ where: { id: res.id } });
    expect(row?.filterAst).toEqual({ eq: ["$.type", "payment"] });
  });

  it("search_events requires an Anthropic key", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("mcps")}@test.local` } });
    await expect(
      findTool("search_events")!.handler(user.id, { query: "failed events yesterday" }),
    ).rejects.toThrow(/Anthropic API key/i);
  });

  it("create_route rejects an invalid filter without creating a route", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("mcpbad")}@test.local` } });
    const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("mcpbad-s") } });
    const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/h" } });

    await expect(
      findTool("create_route")!.handler(user.id, {
        sourceId: source.id,
        destinationId: dest.id,
        filter: { bogus: true },
      }),
    ).rejects.toThrow(/invalid filter/i);

    const routes = await prisma.route.findMany({ where: { sourceId: source.id } });
    expect(routes).toHaveLength(0);
  });
});
