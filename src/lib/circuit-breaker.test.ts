// Tests in this file touch the dev Postgres via the Prisma client, which
// reads DATABASE_URL at module-load time. Match the convention used by
// the workers and scripts (see src/workers/delivery.ts) and load .env
// before any module that transitively imports `prisma`.
import "dotenv/config";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getFailureThreshold, recordSuccess } from "./circuit-breaker";
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
    const d = await makeDestination(u.id, { consecutiveFailures: 3 });
    await recordSuccess(d.id);
    const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.consecutiveFailures).toBe(0);
    await prisma.user.delete({ where: { id: u.id } });
  });

  it("is a no-op when the counter is already 0", async () => {
    const u = await makeUser();
    const d = await makeDestination(u.id, { consecutiveFailures: 0 });
    await recordSuccess(d.id);
    const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.consecutiveFailures).toBe(0);
    await prisma.user.delete({ where: { id: u.id } });
  });

  it("does NOT change the enabled flag (manual pause stays paused after a future success — see resume action)", async () => {
    const u = await makeUser();
    const d = await makeDestination(u.id, { enabled: false, consecutiveFailures: 4 });
    await recordSuccess(d.id);
    const after = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.enabled).toBe(false);
    expect(after.consecutiveFailures).toBe(0);
    await prisma.user.delete({ where: { id: u.id } });
  });
});
