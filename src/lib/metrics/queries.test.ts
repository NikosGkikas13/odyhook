import "dotenv/config";
import { describe, it, expect } from "vitest";

import { DeliveryStatus } from "@/generated/prisma/enums";

import { prisma } from "../prisma";
import { getLatency, getOverviewTotals, getSuccessRate, getThroughput, getTopFailing } from "./queries";

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
      // 1h window @ 1-min buckets = 60 closed buckets + 1 in-progress = 61.
      expect(rows).toHaveLength(61);
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

  it("scopes to a single destination when destinationId is provided", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const da = await prisma.destination.create({
        data: { userId: u.id, name: "A", url: "https://a.test/" },
      });
      const db = await prisma.destination.create({
        data: { userId: u.id, name: "B", url: "https://b.test/" },
      });
      const now = new Date();
      const e1 = await makeEvent(s.id, new Date(now.getTime() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(now.getTime() - 6 * 60_000));
      const e3 = await makeEvent(s.id, new Date(now.getTime() - 7 * 60_000));
      // e1 + e2 go to destination A; e3 goes to destination B only.
      await prisma.delivery.createMany({
        data: [
          { eventId: e1.id, destinationId: da.id, status: "delivered" },
          { eventId: e2.id, destinationId: da.id, status: "delivered" },
          { eventId: e3.id, destinationId: db.id, status: "delivered" },
        ],
      });

      const rowsA = await getThroughput({ userId: u.id, since: "1h", destinationId: da.id });
      expect(rowsA.reduce((acc, r) => acc + r.count, 0)).toBe(2);
      const rowsB = await getThroughput({ userId: u.id, since: "1h", destinationId: db.id });
      expect(rowsB.reduce((acc, r) => acc + r.count, 0)).toBe(1);
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

describe("getLatency", () => {
  it("returns p50/p95 in ms for delivered events", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const now = new Date();
      const recv = new Date(now.getTime() - 5 * 60_000); // 5 minutes ago
      const e1 = await makeEvent(s.id, recv);
      const e2 = await makeEvent(s.id, recv);
      const e3 = await makeEvent(s.id, recv);
      // Latencies: 100ms, 200ms, 1000ms -> p50=200, p95~~960 (Postgres
      // percentile_cont interpolates; we just check approximate ordering).
      await prisma.delivery.createMany({
        data: [
          { eventId: e1.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 100) },
          { eventId: e2.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 200) },
          { eventId: e3.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 1000) },
        ],
      });

      const rows = await getLatency({ userId: u.id, since: "1h" });
      const withData = rows.filter((r) => r.p50 !== null);
      expect(withData).toHaveLength(1);
      expect(withData[0].p50).toBeGreaterThanOrEqual(100);
      expect(withData[0].p50).toBeLessThanOrEqual(300);
      expect(withData[0].p95).toBeGreaterThanOrEqual(withData[0].p50!);
      expect(withData[0].p95).toBeLessThanOrEqual(1000);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("excludes deliveries that aren't 'delivered'", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const e = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      await makeDelivery(e.id, d.id, "failed");

      const rows = await getLatency({ userId: u.id, since: "1h" });
      const withData = rows.filter((r) => r.p50 !== null);
      expect(withData).toHaveLength(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});

describe("getTopFailing", () => {
  it("ranks destinations by failed+exhausted count, descending", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const da = await makeDestination(u.id, "A");
      const db = await makeDestination(u.id, "B");
      const e1 = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(Date.now() - 6 * 60_000));
      const e3 = await makeEvent(s.id, new Date(Date.now() - 7 * 60_000));

      await makeDelivery(e1.id, da.id, "failed");
      await makeDelivery(e2.id, da.id, "exhausted");
      await makeDelivery(e3.id, db.id, "failed");

      const rows = await getTopFailing({ userId: u.id, since: "1h" });
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe("A");
      expect(rows[0].failures).toBe(2);
      expect(rows[1].name).toBe("B");
      expect(rows[1].failures).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("returns an empty array when there are no failures", async () => {
    const u = await makeUser();
    try {
      const rows = await getTopFailing({ userId: u.id, since: "1h" });
      expect(rows).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("ignores other users' destinations", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    try {
      const s = await makeSource(u1.id);
      const d = await makeDestination(u1.id);
      const e = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      await makeDelivery(e.id, d.id, "failed");

      const rows = await getTopFailing({ userId: u2.id, since: "1h" });
      expect(rows).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: u1.id } });
      await prisma.user.delete({ where: { id: u2.id } });
    }
  });
});

describe("getOverviewTotals", () => {
  it("computes total events, success rate, p95 latency, active sources", async () => {
    const u = await makeUser();
    try {
      const sA = await makeSource(u.id, "A");
      const sB = await makeSource(u.id, "B");
      const d = await makeDestination(u.id);
      const recv = new Date(Date.now() - 5 * 60_000);
      const e1 = await makeEvent(sA.id, recv);
      const e2 = await makeEvent(sA.id, recv);
      const e3 = await makeEvent(sB.id, recv);

      await prisma.delivery.createMany({
        data: [
          { eventId: e1.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 100) },
          { eventId: e2.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 200) },
          { eventId: e3.id, destinationId: d.id, status: "failed" },
        ],
      });

      const t = await getOverviewTotals({ userId: u.id, since: "1h" });
      expect(t.totalEvents).toBe(3);
      expect(t.activeSources).toBe(2);
      // 2 delivered / (2 delivered + 1 failed) = 66.66...%
      expect(t.successRate).toBeCloseTo(66.67, 1);
      expect(t.p95LatencyMs).toBeGreaterThanOrEqual(100);
      expect(t.p95LatencyMs).toBeLessThanOrEqual(300);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("returns zeros / nulls when there is no data", async () => {
    const u = await makeUser();
    try {
      const t = await getOverviewTotals({ userId: u.id, since: "1h" });
      expect(t.totalEvents).toBe(0);
      expect(t.activeSources).toBe(0);
      expect(t.successRate).toBeNull();
      expect(t.p95LatencyMs).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
