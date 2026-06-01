import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { listEvents } from "./events";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("listEvents filters", () => {
  it("filters by sourceId", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("evf")}@test.local` } });
    const s1 = await prisma.source.create({ data: { userId: user.id, name: "a", slug: uniq("evf-a") } });
    const s2 = await prisma.source.create({ data: { userId: user.id, name: "b", slug: uniq("evf-b") } });
    await prisma.event.create({ data: { sourceId: s1.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });
    await prisma.event.create({ data: { sourceId: s2.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });

    const res = await listEvents(user.id, { limit: 25, cursor: null }, { sourceId: s1.id });
    expect(res.data).toHaveLength(1);
    expect(res.data.every((e) => e.sourceId === s1.id)).toBe(true);
  });

  it("filters by since/until time range", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("evt")}@test.local` } });
    const s = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("evt-s") } });
    const old = await prisma.event.create({ data: { sourceId: s.id, method: "POST", headersJson: {}, bodyRaw: "{}", receivedAt: new Date("2020-01-01T00:00:00Z") } });
    const recent = await prisma.event.create({ data: { sourceId: s.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });

    const res = await listEvents(user.id, { limit: 25, cursor: null }, { sourceId: s.id, since: "2021-01-01T00:00:00Z" });
    const ids = res.data.map((e) => e.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });

  it("filters by until (excludes events after the bound)", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("evu")}@test.local` } });
    const s = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("evu-s") } });
    const old = await prisma.event.create({ data: { sourceId: s.id, method: "POST", headersJson: {}, bodyRaw: "{}", receivedAt: new Date("2020-01-01T00:00:00Z") } });
    const recent = await prisma.event.create({ data: { sourceId: s.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });

    const res = await listEvents(user.id, { limit: 25, cursor: null }, { sourceId: s.id, until: "2021-01-01T00:00:00Z" });
    const ids = res.data.map((e) => e.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(recent.id);
  });

  it("throws on an invalid since timestamp", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("evb")}@test.local` } });
    await expect(listEvents(user.id, { limit: 25, cursor: null }, { since: "not-a-date" })).rejects.toThrow(/invalid since/i);
  });
});
