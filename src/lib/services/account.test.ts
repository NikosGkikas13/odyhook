import "dotenv/config";
import { describe, it, expect } from "vitest";

import { prisma } from "@/lib/prisma";
import { exportAccountData, deleteUserAccount } from "./account";

let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2)}`;
}

// Builds a full owned graph for one user: source (with a signing secret),
// destination (with encrypted headers), route, event, delivery, API token, and
// BYOK key. Returns the ids so tests can assert export/erasure behaviour.
async function makeAccount() {
  const user = await prisma.user.create({
    data: { email: `${uniq("acct")}@test.local`, name: "Test User" },
  });
  const source = await prisma.source.create({
    data: {
      userId: user.id,
      name: "src",
      slug: uniq("slug"),
      signingSecret: "SECRET-ciphertext",
      verifyStyle: "stripe",
    },
  });
  const destination = await prisma.destination.create({
    data: {
      userId: user.id,
      name: "dst",
      url: "https://example.com/hook",
      headersEnc: "HEADERS-ciphertext",
    },
  });
  const route = await prisma.route.create({
    data: { sourceId: source.id, destinationId: destination.id },
  });
  const event = await prisma.event.create({
    data: {
      sourceId: source.id,
      method: "POST",
      headersJson: { "content-type": "application/json" },
      bodyRaw: '{"hello":"world"}',
    },
  });
  const delivery = await prisma.delivery.create({
    data: { eventId: event.id, destinationId: destination.id },
  });
  const token = await prisma.apiToken.create({
    data: {
      userId: user.id,
      name: "tok",
      tokenHash: uniq("hash"),
      prefix: "ody_test",
    },
  });
  await prisma.providerKey.create({
    data: { userId: user.id, provider: "anthropic", keyEnc: "KEY-ciphertext" },
  });
  return { user, source, destination, route, event, delivery, token };
}

describe("exportAccountData", () => {
  it("is owner-scoped and omits encrypted secrets", async () => {
    const a = await makeAccount();
    const b = await makeAccount();

    const out = await exportAccountData(a.user.id);

    // Right account, no other tenant's rows.
    expect(out.account?.email).toBe(a.user.email);
    expect(out.sources).toHaveLength(1);
    expect((out.sources[0] as { id: string }).id).toBe(a.source.id);
    expect(out.events.map((e) => (e as { id: string }).id)).toContain(a.event.id);
    expect(out.events.map((e) => (e as { id: string }).id)).not.toContain(b.event.id);

    // Secrets must not leak into the export.
    expect(out.sources[0]).not.toHaveProperty("signingSecret");
    expect(out.destinations[0]).not.toHaveProperty("headersEnc");
    expect(out.destinations[0]).not.toHaveProperty("outboundSecretEnc");

    // Personal data the user is entitled to IS present.
    expect((out.events[0] as { bodyRaw: string }).bodyRaw).toBeDefined();
  });
});

describe("deleteUserAccount", () => {
  it("cascades to all owned rows and leaves other tenants intact", async () => {
    const a = await makeAccount();
    const b = await makeAccount();

    await deleteUserAccount(a.user.id);

    expect(await prisma.user.findUnique({ where: { id: a.user.id } })).toBeNull();
    expect(await prisma.source.findUnique({ where: { id: a.source.id } })).toBeNull();
    expect(await prisma.destination.findUnique({ where: { id: a.destination.id } })).toBeNull();
    expect(await prisma.route.findUnique({ where: { id: a.route.id } })).toBeNull();
    expect(await prisma.event.findUnique({ where: { id: a.event.id } })).toBeNull();
    expect(await prisma.delivery.findUnique({ where: { id: a.delivery.id } })).toBeNull();
    expect(await prisma.apiToken.findUnique({ where: { id: a.token.id } })).toBeNull();
    expect(await prisma.providerKey.findFirst({ where: { userId: a.user.id } })).toBeNull();

    // Other tenant untouched.
    expect(await prisma.user.findUnique({ where: { id: b.user.id } })).not.toBeNull();
    expect(await prisma.event.findUnique({ where: { id: b.event.id } })).not.toBeNull();
  });
});
