import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { setRouteFilter, clearRouteFilter } from "./routes";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setupRoute() {
  const user = await prisma.user.create({ data: { email: `${uniq("rf")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("rf-s") } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/h" } });
  const route = await prisma.route.create({ data: { sourceId: source.id, destinationId: dest.id } });
  return { user, route };
}

describe("setRouteFilter / clearRouteFilter", () => {
  it("persists and clears a filter AST", async () => {
    const { user, route } = await setupRoute();

    expect(await setRouteFilter(user.id, route.id, { exists: "$.id" })).toBe(true);
    const afterSet = await prisma.route.findUnique({ where: { id: route.id } });
    expect(afterSet?.filterAst).toEqual({ exists: "$.id" });

    expect(await clearRouteFilter(user.id, route.id)).toBe(true);
    const afterClear = await prisma.route.findUnique({ where: { id: route.id } });
    expect(afterClear?.filterAst).toBeNull();
  });

  it("returns false for another user's route", async () => {
    const a = await setupRoute();
    const b = await prisma.user.create({ data: { email: `${uniq("rf2")}@test.local` } });
    expect(await setRouteFilter(b.id, a.route.id, { exists: "$.id" })).toBe(false);
  });

  it("persists the prompt when provided", async () => {
    const { user, route } = await setupRoute();
    await setRouteFilter(user.id, route.id, { exists: "$.id" }, "only events with an id");
    const row = await prisma.route.findUnique({ where: { id: route.id } });
    expect(row?.filterPrompt).toBe("only events with an id");
  });
});
