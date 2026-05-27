import "dotenv/config";
import { describe, it, expect } from "vitest";

import { prisma } from "../prisma";
import { getThroughput } from "./queries";

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
