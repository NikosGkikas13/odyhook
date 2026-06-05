import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";

// Replay authenticates via the NextAuth session. Stub auth() so we can drive
// the DB path with a known user id.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

import { POST } from "./route";

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function req(): Request {
  return new Request("http://x/api/events/e/replay", {
    method: "POST",
    headers: { origin: "http://x" },
  });
}

beforeEach(() => {
  authMock.mockReset();
});

describe("POST /api/events/[id]/replay — destination pause filter", () => {
  it("does not enqueue deliveries to paused destinations", async () => {
    const user = await prisma.user.create({
      data: { email: `replay-${uniq()}@test.local` },
    });
    authMock.mockResolvedValue({ user: { id: user.id } });

    const source = await prisma.source.create({
      data: { userId: user.id, name: "S", slug: `replay-${uniq()}` },
    });
    const enabledDest = await prisma.destination.create({
      data: { userId: user.id, name: "on", url: "https://example.test/on" },
    });
    const pausedDest = await prisma.destination.create({
      data: {
        userId: user.id,
        name: "off",
        url: "https://example.test/off",
        enabled: false,
      },
    });
    await prisma.route.create({
      data: { sourceId: source.id, destinationId: enabledDest.id, enabled: true },
    });
    await prisma.route.create({
      data: { sourceId: source.id, destinationId: pausedDest.id, enabled: true },
    });
    const event = await prisma.event.create({
      data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" },
    });

    const res = await POST(req(), { params: Promise.resolve({ id: event.id }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; deliveries: number };
    expect(json.deliveries).toBe(1);

    // Only the enabled destination got a fresh delivery.
    const deliveries = await prisma.delivery.findMany({
      where: { eventId: event.id },
      select: { destinationId: true },
    });
    expect(deliveries.map((d) => d.destinationId)).toEqual([enabledDest.id]);
  });
});
