import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createRoute, getRoute, listRoutes, updateRoute, deleteRoute } from "./routes";

async function makeUserWithSourceAndDest() {
  const user = await prisma.user.create({
    data: { email: `rt-svc-${Date.now()}-${Math.random()}@test.local` },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "s", slug: `rt-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const dest = await prisma.destination.create({
    data: { userId: user.id, name: "d", url: "https://example.test/" },
  });
  return { user, source, dest };
}

describe("routes service", () => {
  it("creates a route between owned source and destination", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    const dto = await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    expect(dto.sourceId).toBe(source.id);
    expect(dto.destinationId).toBe(dest.id);
    expect(dto.enabled).toBe(true);
  });

  it("rejects creating a route to a destination the caller doesn't own", async () => {
    const a = await makeUserWithSourceAndDest();
    const b = await makeUserWithSourceAndDest();
    await expect(
      createRoute(a.user.id, { sourceId: a.source.id, destinationId: b.dest.id }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a duplicate (source,destination) route with a conflict", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    await expect(
      createRoute(user.id, { sourceId: source.id, destinationId: dest.id }),
    ).rejects.toThrow(/conflict/i);
  });

  it("updates enabled and deletes, owner-scoped", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    const r = await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    const up = await updateRoute(user.id, r.id, { enabled: false });
    expect(up?.enabled).toBe(false);
    expect(await getRoute(user.id, r.id)).not.toBeNull();
    expect(await deleteRoute(user.id, r.id)).toBe(true);
  });

  it("lists routes for owned sources only", async () => {
    const a = await makeUserWithSourceAndDest();
    await createRoute(a.user.id, { sourceId: a.source.id, destinationId: a.dest.id });
    const list = await listRoutes(a.user.id, { limit: 25, cursor: null });
    expect(list.data.length).toBeGreaterThanOrEqual(1);
    expect(list.data.every((r) => r.sourceId === a.source.id)).toBe(true);
  });

  it("no-op on empty update returns unchanged DTO", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    const r = await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    const up = await updateRoute(user.id, r.id, {});
    expect(up?.id).toBe(r.id);
  });
});
