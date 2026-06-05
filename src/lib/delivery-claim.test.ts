import "dotenv/config";
import { describe, it, expect } from "vitest";

import type { DeliveryStatus } from "@/generated/prisma/enums";

import { prisma } from "./prisma";
import { claimDelivery, findStalledDeliveryIds } from "./delivery-claim";

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Create a Delivery (plus its owning user/source/destination/event) in `status`. */
async function makeDelivery(
  status: DeliveryStatus,
  opts: { createdAt?: Date } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `claim-${uniq()}@test.local` },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "S", slug: `claim-${uniq()}` },
  });
  const dest = await prisma.destination.create({
    data: { userId: user.id, name: "d", url: "https://example.test/" },
  });
  const event = await prisma.event.create({
    data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" },
  });
  const delivery = await prisma.delivery.create({
    data: {
      eventId: event.id,
      destinationId: dest.id,
      status,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return delivery.id;
}

const PAST = new Date(Date.now() - 60 * 60_000);
const FUTURE = new Date(Date.now() + 60 * 60_000);

describe("claimDelivery (CAS)", () => {
  it("claims a pending row and flips it to in_flight", async () => {
    const id = await makeDelivery("pending");
    expect(await claimDelivery(id)).toBe(true);
    const row = await prisma.delivery.findUnique({ where: { id } });
    expect(row?.status).toBe("in_flight");
  });

  it("claims a failed row (retry path)", async () => {
    const id = await makeDelivery("failed");
    expect(await claimDelivery(id)).toBe(true);
  });

  it("refuses a delivered row (terminal)", async () => {
    const id = await makeDelivery("delivered");
    expect(await claimDelivery(id)).toBe(false);
  });

  it("refuses an exhausted row (terminal)", async () => {
    const id = await makeDelivery("exhausted");
    expect(await claimDelivery(id)).toBe(false);
  });

  it("refuses a freshly in_flight row (another worker owns it)", async () => {
    const id = await makeDelivery("in_flight");
    // Stale threshold in the past → a just-created in_flight row is not stale.
    expect(await claimDelivery(id, PAST)).toBe(false);
  });

  it("reclaims a stale (orphaned) in_flight row", async () => {
    const id = await makeDelivery("in_flight");
    // Stale threshold in the future → treat any in_flight row as orphaned.
    expect(await claimDelivery(id, FUTURE)).toBe(true);
  });

  it("only one of two concurrent claims wins", async () => {
    const id = await makeDelivery("pending");
    const [a, b] = await Promise.all([claimDelivery(id), claimDelivery(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("findStalledDeliveryIds", () => {
  it("finds pending rows older than the pending cutoff", async () => {
    const id = await makeDelivery("pending", { createdAt: PAST });
    const ids = await findStalledDeliveryIds({
      pendingBefore: new Date(Date.now() - 30 * 60_000),
      inFlightBefore: PAST,
      take: 1000,
    });
    expect(ids).toContain(id);
  });

  it("ignores pending rows newer than the pending cutoff", async () => {
    const id = await makeDelivery("pending");
    const ids = await findStalledDeliveryIds({
      pendingBefore: PAST,
      inFlightBefore: PAST,
      take: 1000,
    });
    expect(ids).not.toContain(id);
  });

  it("finds in_flight rows older than the in_flight cutoff", async () => {
    const id = await makeDelivery("in_flight");
    const ids = await findStalledDeliveryIds({
      pendingBefore: PAST,
      inFlightBefore: FUTURE,
      take: 1000,
    });
    expect(ids).toContain(id);
  });

  it("ignores fresh in_flight rows", async () => {
    const id = await makeDelivery("in_flight");
    const ids = await findStalledDeliveryIds({
      pendingBefore: PAST,
      inFlightBefore: PAST,
      take: 1000,
    });
    expect(ids).not.toContain(id);
  });

  it("never returns terminal rows", async () => {
    const delivered = await makeDelivery("delivered");
    const exhausted = await makeDelivery("exhausted");
    const ids = await findStalledDeliveryIds({
      pendingBefore: FUTURE,
      inFlightBefore: FUTURE,
      take: 1000,
    });
    expect(ids).not.toContain(delivered);
    expect(ids).not.toContain(exhausted);
  });
});
