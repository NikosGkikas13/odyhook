import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { listEvents, getEvent } from "./events";

async function setup() {
  const user = await prisma.user.create({
    data: { email: `ev-svc-${Date.now()}-${Math.random()}@test.local` },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "s", slug: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  return { user, source };
}

describe("events service", () => {
  it("lists owner's events newest-first with a working cursor", async () => {
    const { user, source } = await setup();
    for (let i = 0; i < 3; i++) {
      await prisma.event.create({
        data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: `{"i":${i}}`, receivedAt: new Date(Date.now() + i * 1000) },
      });
    }
    const page1 = await listEvents(user.id, { limit: 2, cursor: null });
    expect(page1.data.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listEvents(user.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.data.length).toBe(1);
    // No overlap between pages.
    const ids = new Set(page1.data.map((e) => e.id));
    expect(page2.data.every((e) => !ids.has(e.id))).toBe(true);
  });

  it("get returns the event with deliveries, owner-scoped", async () => {
    const { user, source } = await setup();
    const ev = await prisma.event.create({
      data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" },
    });
    const got = await getEvent(user.id, ev.id);
    expect(got?.id).toBe(ev.id);
    expect(Array.isArray(got?.deliveries)).toBe(true);

    const other = await prisma.user.create({ data: { email: `ev-other-${Date.now()}-${Math.random()}@test.local` } });
    expect(await getEvent(other.id, ev.id)).toBeNull();
  });
});
