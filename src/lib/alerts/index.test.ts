import "dotenv/config";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../prisma";

vi.mock("./queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue")>();
  const adds: unknown[] = [];
  return {
    ...actual,
    getAlertsQueue: () => ({
      add: vi.fn(async (name: string, data: unknown) => {
        adds.push({ name, data });
      }),
    }),
    __getAdds: () => adds,
    __resetAdds: () => {
      adds.length = 0;
    },
  };
});

import { maybeEnqueueAlerts } from "./index";
// @ts-expect-error — accessing test-only export via mock
import { __getAdds, __resetAdds } from "./queue";

async function makeFixture(opts: {
  userAlertConfig?: unknown;
  destAlertConfig?: unknown;
}) {
  const user = await prisma.user.create({
    data: {
      email: `idx-${Date.now()}-${Math.random()}@test.local`,
      alertConfigJson: opts.userAlertConfig as never,
    },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "src", slug: `src-${Date.now()}-${Math.random()}` },
  });
  const dest = await prisma.destination.create({
    data: {
      userId: user.id,
      name: "dst",
      url: "https://example.test/hook",
      alertConfigJson: opts.destAlertConfig as never,
    },
  });
  return { user, source, dest };
}

async function createDelivery(
  sourceId: string,
  destinationId: string,
  status: "delivered" | "failed" | "exhausted",
) {
  const event = await prisma.event.create({
    data: {
      sourceId,
      method: "POST",
      headersJson: {},
      bodyRaw: "{}",
    },
  });
  return prisma.delivery.create({
    data: { eventId: event.id, destinationId, status },
  });
}

describe("maybeEnqueueAlerts", () => {
  beforeEach(() => __resetAdds());

  it("enqueues an exhausted-trigger job when the outcome is exhausted and trigger is on", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { exhausted: { enabled: true } },
      },
    });
    const delivery = await createDelivery(source.id, dest.id, "exhausted");

    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: delivery.id,
      outcomeStatus: "exhausted",
      lastError: "HTTP 500",
    });

    const adds = __getAdds() as Array<{ name: string; data: { trigger: string } }>;
    expect(adds).toHaveLength(1);
    expect(adds[0].name).toBe("exhausted");
    expect(adds[0].data.trigger).toBe("exhausted");
  });

  it("enqueues nothing when no triggers are enabled", async () => {
    const { source, dest } = await makeFixture({});
    const delivery = await createDelivery(source.id, dest.id, "exhausted");
    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: delivery.id,
      outcomeStatus: "exhausted",
    });
    expect(__getAdds()).toHaveLength(0);
  });

  it("enqueues a failureRate job when the recent window crosses the threshold", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { failureRate: { enabled: true, ratePct: 50, windowCount: 4 } },
      },
    });
    // Build a history of 2 failures + 2 successes — 50% fail rate.
    await createDelivery(source.id, dest.id, "delivered");
    await createDelivery(source.id, dest.id, "delivered");
    await createDelivery(source.id, dest.id, "failed");
    const current = await createDelivery(source.id, dest.id, "exhausted");

    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: current.id,
      outcomeStatus: "exhausted",
    });
    const adds = __getAdds() as Array<{ name: string }>;
    expect(adds.map((a) => a.name)).toContain("failureRate");
  });

  it("does not double-fire firstFailure when only 2 prior successes exist (need 3)", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { firstFailure: { enabled: true, afterSuccessCount: 3 } },
      },
    });
    await createDelivery(source.id, dest.id, "delivered");
    await createDelivery(source.id, dest.id, "delivered");
    const current = await createDelivery(source.id, dest.id, "exhausted");

    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: current.id,
      outcomeStatus: "exhausted",
    });
    expect(__getAdds()).toEqual([]);
  });

  it("no-ops when both user and destination configs are null", async () => {
    const { source, dest } = await makeFixture({});
    // Both user.alertConfigJson and dest.alertConfigJson default to null.
    const delivery = await createDelivery(source.id, dest.id, "exhausted");
    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: delivery.id,
      outcomeStatus: "exhausted",
    });
    expect(__getAdds()).toEqual([]);
  });

  it("no-ops when triggers are enabled but no channels are", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: {},
        triggers: { exhausted: { enabled: true } },
      },
    });
    const delivery = await createDelivery(source.id, dest.id, "exhausted");
    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: delivery.id,
      outcomeStatus: "exhausted",
    });
    expect(__getAdds()).toEqual([]);
  });
});
