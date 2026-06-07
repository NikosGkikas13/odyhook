import "dotenv/config";
import { describe, it, expect } from "vitest";

import { prisma } from "@/lib/prisma";
import { purgeExpiredEvents } from "./retention";

let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2)}`;
}

const DAY = 24 * 60 * 60 * 1000;

async function makeSource(retentionDays: number | null) {
  const user = await prisma.user.create({
    data: { email: `${uniq("ret")}@test.local` },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "s", slug: uniq("slug"), retentionDays },
  });
  return source;
}

async function addEvent(sourceId: string, receivedAt: Date) {
  return prisma.event.create({
    data: { sourceId, method: "POST", headersJson: {}, bodyRaw: "{}", receivedAt },
  });
}

describe("purgeExpiredEvents", () => {
  it("deletes events older than the window and keeps fresher ones", async () => {
    const now = new Date();
    const src = await makeSource(30);
    const old = await addEvent(src.id, new Date(now.getTime() - 40 * DAY));
    const fresh = await addEvent(src.id, new Date(now.getTime() - 10 * DAY));

    const res = await purgeExpiredEvents(now);

    expect(res.eventsDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.event.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.event.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it("cascade-deletes the purged events' deliveries", async () => {
    const now = new Date();
    const src = await makeSource(30);
    const user = await prisma.user.findFirstOrThrow({
      where: { sources: { some: { id: src.id } } },
    });
    const dest = await prisma.destination.create({
      data: { userId: user.id, name: "d", url: "https://example.com" },
    });
    const old = await addEvent(src.id, new Date(now.getTime() - 40 * DAY));
    const delivery = await prisma.delivery.create({
      data: { eventId: old.id, destinationId: dest.id },
    });

    await purgeExpiredEvents(now);

    expect(await prisma.delivery.findUnique({ where: { id: delivery.id } })).toBeNull();
  });

  it("never purges a source with null retention (keep indefinitely)", async () => {
    const now = new Date();
    const src = await makeSource(null);
    const ancient = await addEvent(src.id, new Date(now.getTime() - 1000 * DAY));

    await purgeExpiredEvents(now);

    expect(await prisma.event.findUnique({ where: { id: ancient.id } })).not.toBeNull();
  });
});
