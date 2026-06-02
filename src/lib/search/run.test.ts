import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { runEventSearch } from "./run";
import type { EventQuery } from "./types";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seed() {
  const user = await prisma.user.create({ data: { email: `${uniq("run")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "Stripe", slug: uniq("run-s") } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/h" } });
  // 6 events: 3 gmail, 3 other; alternating, newest last-created.
  for (let i = 0; i < 6; i++) {
    const email = i % 2 === 0 ? `u${i}@gmail.com` : `u${i}@outlook.com`;
    const ev = await prisma.event.create({
      data: {
        sourceId: source.id, method: "POST", headersJson: {},
        bodyRaw: JSON.stringify({ data: { object: { customer: { email } } } }),
      },
    });
    await prisma.delivery.create({
      data: { eventId: ev.id, destinationId: dest.id, status: i === 0 ? "failed" : "delivered" },
    });
  }
  return { user, source };
}

const META_ALL = { sourceId: null, receivedAfter: null, receivedBefore: null, status: null };

describe("runEventSearch", () => {
  let userId = "";
  beforeAll(async () => { userId = (await seed()).user.id; });

  it("fast path: metadata-only paginates newest-first", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: null };
    const page1 = await runEventSearch(userId, q, { limit: 4 });
    expect(page1.events).toHaveLength(4);
    expect(page1.scanCapped).toBe(false);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await runEventSearch(userId, q, { limit: 4, cursor: page1.nextCursor });
    expect(page2.events).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.events, ...page2.events].map((e) => e.id));
    expect(ids.size).toBe(6);
  });

  it("payload path: returns only matching bodies", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] } };
    const res = await runEventSearch(userId, q, { limit: 50 });
    expect(res.events).toHaveLength(3);
    expect(res.events.every((e) => e.bodyRaw.includes("@gmail.com"))).toBe(true);
  });

  it("payload path: resumes across pages without gaps or dupes", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] } };
    const p1 = await runEventSearch(userId, q, { limit: 2 });
    expect(p1.events).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await runEventSearch(userId, q, { limit: 2, cursor: p1.nextCursor });
    const ids = new Set([...p1.events, ...p2.events].map((e) => e.id));
    expect(ids.size).toBe(3);
  });

  it("payload path: scanCapped when the scan cap is hit before filling a page", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: { eq: ["$.data.object.customer.email", "nobody@nowhere.dev"] } };
    const res = await runEventSearch(userId, q, { limit: 10, scanCap: 2, scanBatch: 2 });
    expect(res.events).toHaveLength(0);
    expect(res.scanned).toBe(2);
    expect(res.scanCapped).toBe(true);
    expect(res.nextCursor).not.toBeNull();
  });

  it("filters by delivery status", async () => {
    const q: EventQuery = { metadata: { ...META_ALL, status: ["failed"] }, payload: null };
    const res = await runEventSearch(userId, q, { limit: 50 });
    expect(res.events).toHaveLength(1);
  });

  it("excludes another user's events", async () => {
    const other = await seed();
    const otherSource = await prisma.source.findFirstOrThrow({ where: { userId: other.user.id } });
    const q: EventQuery = { metadata: META_ALL, payload: null };
    const res = await runEventSearch(userId, q, { limit: 50 });
    expect(res.events.some((e) => e.sourceId === otherSource.id)).toBe(false);
  });
});
