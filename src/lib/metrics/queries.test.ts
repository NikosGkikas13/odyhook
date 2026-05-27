import "dotenv/config";
import { describe, it, expect } from "vitest";

import { DeliveryStatus } from "@/generated/prisma/enums";

import { prisma } from "../prisma";
import { getSuccessRate, getThroughput } from "./queries";

async function makeUser() {
  return prisma.user.create({
    data: { email: `metrics-${Date.now()}-${Math.random()}@test.local` },
  });
}

async function makeSource(userId: string, name = "Stripe") {
  return prisma.source.create({
    data: {
      userId,
      name,
      slug: `metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function makeEvent(sourceId: string, receivedAt: Date) {
  return prisma.event.create({
    data: {
      sourceId,
      method: "POST",
      headersJson: {},
      bodyRaw: "{}",
      receivedAt,
    },
  });
}

async function makeDestination(userId: string, name = "dest") {
  return prisma.destination.create({
    data: { userId, name, url: "https://example.test/" },
  });
}

async function makeDelivery(
  eventId: string,
  destinationId: string,
  status: DeliveryStatus,
) {
  return prisma.delivery.create({
    data: { eventId, destinationId, status, attemptCount: 1 },
  });
}

describe("getThroughput", () => {
  it("returns one row per bucket with the event count", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const now = new Date();
      // Three events in the last 30 minutes.
      await makeEvent(s.id, new Date(now.getTime() - 5 * 60_000));
      await makeEvent(s.id, new Date(now.getTime() - 10 * 60_000));
      await makeEvent(s.id, new Date(now.getTime() - 20 * 60_000));

      const rows = await getThroughput({ userId: u.id, since: "1h" });
      const total = rows.reduce((acc, r) => acc + r.count, 0);
      expect(total).toBe(3);
      // 1h window @ 1-min buckets = 60 rows, all present (zero-filled).
      expect(rows).toHaveLength(60);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("scopes to a single source when sourceId is provided", async () => {
    const u = await makeUser();
    try {
      const a = await makeSource(u.id, "A");
      const b = await makeSource(u.id, "B");
      const now = new Date();
      await makeEvent(a.id, new Date(now.getTime() - 5 * 60_000));
      await makeEvent(b.id, new Date(now.getTime() - 5 * 60_000));

      const rowsA = await getThroughput({ userId: u.id, since: "1h", sourceId: a.id });
      const totalA = rowsA.reduce((acc, r) => acc + r.count, 0);
      expect(totalA).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("ignores other users' events", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    try {
      const s = await makeSource(u1.id);
      await makeEvent(s.id, new Date());
      const rows = await getThroughput({ userId: u2.id, since: "1h" });
      const total = rows.reduce((acc, r) => acc + r.count, 0);
      expect(total).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u1.id } });
      await prisma.user.delete({ where: { id: u2.id } });
    }
  });
});

describe("getSuccessRate", () => {
  it("returns delivered and failed counts per bucket", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const now = new Date();
      const e1 = await makeEvent(s.id, new Date(now.getTime() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(now.getTime() - 6 * 60_000));
      const e3 = await makeEvent(s.id, new Date(now.getTime() - 7 * 60_000));
      await makeDelivery(e1.id, d.id, "delivered");
      await makeDelivery(e2.id, d.id, "delivered");
      await makeDelivery(e3.id, d.id, "failed");

      const rows = await getSuccessRate({ userId: u.id, since: "1h" });
      const totalDelivered = rows.reduce((acc, r) => acc + r.delivered, 0);
      const totalFailed = rows.reduce((acc, r) => acc + r.failed, 0);
      expect(totalDelivered).toBe(2);
      expect(totalFailed).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("counts exhausted as failed", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const e = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      await makeDelivery(e.id, d.id, "exhausted");

      const rows = await getSuccessRate({ userId: u.id, since: "1h" });
      const totalFailed = rows.reduce((acc, r) => acc + r.failed, 0);
      expect(totalFailed).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("excludes 'pending' and 'in_flight' deliveries (terminal-status only)", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const e1 = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(Date.now() - 6 * 60_000));
      await makeDelivery(e1.id, d.id, "pending");
      await makeDelivery(e2.id, d.id, "in_flight");

      const rows = await getSuccessRate({ userId: u.id, since: "1h" });
      const total = rows.reduce((acc, r) => acc + r.delivered + r.failed, 0);
      expect(total).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
