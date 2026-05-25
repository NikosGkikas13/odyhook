// Tests in this file touch the dev Postgres via the Prisma client, which
// reads DATABASE_URL at module-load time. Match the convention used by
// the workers and scripts (see src/workers/delivery.ts) and load .env
// before any module that transitively imports `prisma`.
import "dotenv/config";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getFailureThreshold, recordSuccess, recordExhausted } from "./circuit-breaker";
import { prisma } from "./prisma";

describe("getFailureThreshold", () => {
  const original = process.env.DESTINATION_FAILURE_THRESHOLD;
  afterEach(() => {
    if (original === undefined) delete process.env.DESTINATION_FAILURE_THRESHOLD;
    else process.env.DESTINATION_FAILURE_THRESHOLD = original;
  });

  it("defaults to 5 when env var is unset", () => {
    delete process.env.DESTINATION_FAILURE_THRESHOLD;
    expect(getFailureThreshold()).toBe(5);
  });

  it("reads a positive integer from the env var", () => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "12";
    expect(getFailureThreshold()).toBe(12);
  });

  it("falls back to the default if the env var is non-numeric", () => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "abc";
    expect(getFailureThreshold()).toBe(5);
  });

  it("falls back to the default if the env var is <= 0", () => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "0";
    expect(getFailureThreshold()).toBe(5);
  });
});

async function makeUser() {
  return prisma.user.create({
    data: { email: `cb-${Date.now()}-${Math.random()}@test.local` },
  });
}

async function makeDestination(userId: string, overrides: Partial<{
  enabled: boolean;
  consecutiveFailures: number;
  autoDisabledAt: Date | null;
  autoDisabledReason: string | null;
}> = {}) {
  return prisma.destination.create({
    data: {
      userId,
      name: "cb-test",
      url: "https://example.test/hook",
      enabled: overrides.enabled ?? true,
      consecutiveFailures: overrides.consecutiveFailures ?? 0,
      autoDisabledAt: overrides.autoDisabledAt ?? null,
      autoDisabledReason: overrides.autoDisabledReason ?? null,
    },
  });
}

describe("recordSuccess", () => {
  it("resets consecutiveFailures to 0", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, { consecutiveFailures: 3 });
      await recordSuccess(d.id);
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.consecutiveFailures).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("is a no-op when the counter is already 0", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, { consecutiveFailures: 0 });
      await recordSuccess(d.id);
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.consecutiveFailures).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("does NOT change the enabled flag (manual pause stays paused after a future success — see resume action)", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, { enabled: false, consecutiveFailures: 4 });
      await recordSuccess(d.id);
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.enabled).toBe(false);
      expect(after.consecutiveFailures).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});

describe("recordExhausted", () => {
  beforeEach(() => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "3";
  });
  afterEach(() => {
    delete process.env.DESTINATION_FAILURE_THRESHOLD;
  });

  it("increments consecutiveFailures and reports tripped=false below threshold", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, { consecutiveFailures: 0 });
      const r = await recordExhausted(d.id, "HTTP 500");
      expect(r.tripped).toBe(false);
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.consecutiveFailures).toBe(1);
      expect(after.enabled).toBe(true);
      expect(after.autoDisabledAt).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("flips enabled=false and reports tripped=true when threshold is reached", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, { consecutiveFailures: 2 });
      const r = await recordExhausted(d.id, "HTTP 502");
      expect(r.tripped).toBe(true);
      if (r.tripped) {
        expect(r.destinationName).toBe("cb-test");
        expect(r.ownerEmail).toBe(u.email);
        expect(r.consecutiveFailures).toBe(3);
      }
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.enabled).toBe(false);
      expect(after.consecutiveFailures).toBe(3);
      expect(after.autoDisabledReason).toBe("HTTP 502");
      expect(after.autoDisabledAt).toBeInstanceOf(Date);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("does not flip a destination that is already disabled (manual pause)", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, {
        enabled: false,
        consecutiveFailures: 10,
      });
      const r = await recordExhausted(d.id, "HTTP 500");
      expect(r.tripped).toBe(false);
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.autoDisabledAt).toBeNull();
      expect(after.consecutiveFailures).toBe(10); // counter must NOT be incremented when already disabled
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("only one concurrent caller reports tripped=true (race-safety)", async () => {
    const u = await makeUser();
    try {
      const d = await makeDestination(u.id, { consecutiveFailures: 2 });
      const [a, b] = await Promise.all([
        recordExhausted(d.id, "race-a"),
        recordExhausted(d.id, "race-b"),
      ]);
      const trippedCount = [a, b].filter((r) => r.tripped).length;
      expect(trippedCount).toBe(1);
      const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.enabled).toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
