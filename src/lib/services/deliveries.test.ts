import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { listDeliveries } from "./deliveries";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const user = await prisma.user.create({ data: { email: `${uniq("del")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("del-s"), verifyStyle: "stripe" } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/hook" } });
  const event = await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });
  return { user, source, dest, event };
}

describe("listDeliveries", () => {
  it("filters by source and status, scoped to the user", async () => {
    const { user, source, dest, event } = await setup();
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "failed", attemptCount: 3 } });
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "delivered", attemptCount: 1 } });

    const failed = await listDeliveries(
      user.id,
      { sourceId: source.id, status: ["failed", "exhausted"] },
      { limit: 25, cursor: null },
    );
    expect(failed.data).toHaveLength(1);
    expect(failed.data[0].status).toBe("failed");
    expect(failed.data[0].sourceId).toBe(source.id);
    expect(failed.data[0].destinationId).toBe(dest.id);
  });

  it("does not return another user's deliveries", async () => {
    const a = await setup();
    await prisma.delivery.create({ data: { eventId: a.event.id, destinationId: a.dest.id, status: "failed", attemptCount: 1 } });
    const b = await setup();
    const res = await listDeliveries(b.user.id, {}, { limit: 25, cursor: null });
    expect(res.data.every((d) => d.sourceId !== a.source.id)).toBe(true);
  });

  it("filters by destinationId", async () => {
    const { user, source, dest, event } = await setup();
    const dest2 = await prisma.destination.create({ data: { userId: user.id, name: "d2", url: "https://example.com/two" } });
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "delivered", attemptCount: 1 } });
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest2.id, status: "delivered", attemptCount: 1 } });

    const res = await listDeliveries(user.id, { sourceId: source.id, destinationId: dest2.id }, { limit: 25, cursor: null });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].destinationId).toBe(dest2.id);
  });

  it("emits a nextCursor when the page is full", async () => {
    const { user, source, dest, event } = await setup();
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "delivered", attemptCount: 1 } });
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "delivered", attemptCount: 1 } });

    const res = await listDeliveries(user.id, { sourceId: source.id }, { limit: 1, cursor: null });
    expect(res.data).toHaveLength(1);
    expect(res.nextCursor).not.toBeNull();
  });

  it("throws on an invalid since timestamp", async () => {
    const { user } = await setup();
    await expect(listDeliveries(user.id, { since: "not-a-date" }, { limit: 25, cursor: null })).rejects.toThrow(/invalid since/i);
  });
});
