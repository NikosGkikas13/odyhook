import "dotenv/config";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma";
import { getConnection } from "../lib/queue";
import { getAlertsQueue, ALERTS_QUEUE } from "../lib/alerts/queue";
import { cooldownKey } from "../lib/alerts/cooldown";
import { encrypt } from "../lib/crypto";

// Hoist mocks: dispatch is the I/O seam.
vi.mock("../lib/alerts/dispatch", () => ({
  dispatchEmail: vi.fn().mockResolvedValue(undefined),
  dispatchSlack: vi.fn().mockResolvedValue(undefined),
  dispatchGenericWebhook: vi.fn().mockResolvedValue(undefined),
}));

import {
  dispatchEmail,
  dispatchSlack,
  dispatchGenericWebhook,
} from "../lib/alerts/dispatch";
import { runAlertJob } from "./alerts";

async function makeUserDestination(opts: {
  userAlertConfig?: unknown;
  destAlertConfig?: unknown;
}) {
  const user = await prisma.user.create({
    data: {
      email: `alert-${Date.now()}-${Math.random()}@test.local`,
      alertConfigJson: opts.userAlertConfig as never,
    },
  });
  const dest = await prisma.destination.create({
    data: {
      userId: user.id,
      name: "test-dest",
      url: "https://example.test/hook",
      alertConfigJson: opts.destAlertConfig as never,
    },
  });
  return { user, dest };
}

describe("runAlertJob", () => {
  const redis = getConnection();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await getAlertsQueue().close();
  });

  it("dispatches to all enabled channels once when cooldown is unclaimed", async () => {
    const slackEnc = encrypt("https://hooks.slack.com/services/T/B/abc");
    const webhookEnc = encrypt("https://example.com/hook");
    const { user, dest } = await makeUserDestination({
      userAlertConfig: {
        channels: {
          email: { enabled: true },
          slack: { enabled: true, webhookUrlEnc: slackEnc },
          webhook: { enabled: true, urlEnc: webhookEnc },
        },
        triggers: { exhausted: { enabled: true } },
        cooldownMinutes: 15,
      },
    });
    await redis.del(cooldownKey(dest.id, "exhausted"));

    await runAlertJob({
      destinationId: dest.id,
      trigger: "exhausted",
      deliveryId: "del_test",
      lastError: "HTTP 500",
    });

    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEmail).toHaveBeenCalledWith(user.email, expect.objectContaining({
      destinationId: dest.id,
      trigger: "exhausted",
    }));
    expect(dispatchSlack).toHaveBeenCalledTimes(1);
    expect(dispatchGenericWebhook).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the cooldown is already claimed", async () => {
    const { dest } = await makeUserDestination({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { exhausted: { enabled: true } },
        cooldownMinutes: 15,
      },
    });
    await redis.set(cooldownKey(dest.id, "exhausted"), "1", "EX", 60);

    await runAlertJob({
      destinationId: dest.id,
      trigger: "exhausted",
      deliveryId: "del_test",
    });

    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it("continues dispatching other channels when one throws", async () => {
    vi.mocked(dispatchSlack).mockRejectedValueOnce(new Error("slack down"));
    const slackEnc = encrypt("https://hooks.slack.com/services/T/B/abc");
    const { dest } = await makeUserDestination({
      userAlertConfig: {
        channels: {
          email: { enabled: true },
          slack: { enabled: true, webhookUrlEnc: slackEnc },
        },
        triggers: { exhausted: { enabled: true } },
      },
    });
    await redis.del(cooldownKey(dest.id, "exhausted"));

    await expect(
      runAlertJob({
        destinationId: dest.id,
        trigger: "exhausted",
        deliveryId: "del_test",
      }),
    ).rejects.toThrow(/slack down/);

    // Email still went through despite the Slack failure.
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
  });

  it("silently drops when the destination has been deleted", async () => {
    await expect(
      runAlertJob({
        destinationId: "nonexistent",
        trigger: "exhausted",
        deliveryId: "del_test",
      }),
    ).resolves.toBeUndefined();
    expect(dispatchEmail).not.toHaveBeenCalled();
  });
});
