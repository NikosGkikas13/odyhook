import "dotenv/config";
import { describe, it, expect, vi } from "vitest";

// assertSafeUrl does a live DNS lookup which fails for .test TLDs in CI/dev.
// We swap it out with parseSafeUrl (sync, IP-only SSRF guard) so tests can
// use https://example.test/… URLs while still rejecting private IP literals
// like 169.254.169.254.
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ssrf")>();
  return { ...mod, assertSafeUrl: (url: string) => Promise.resolve(mod.parseSafeUrl(url)) };
});

import { prisma } from "../prisma";
import {
  createDestination,
  getDestination,
  listDestinations,
  updateDestination,
  deleteDestination,
} from "./destinations";

async function makeUser() {
  return prisma.user.create({
    data: { email: `dst-svc-${Date.now()}-${Math.random()}@test.local` },
  });
}

describe("destinations service", () => {
  it("creates with headers + outbound secret, returns secret-free DTO", async () => {
    const u = await makeUser();
    const dto = await createDestination(u.id, {
      name: "hook",
      url: "https://example.test/hook",
      headers: "X-Api-Key: abc",
      outboundSecret: "supersecretsupersecret",
    });
    expect(dto.url).toBe("https://example.test/hook");
    expect(dto.hasHeaders).toBe(true);
    expect(dto.hasOutboundSecret).toBe(true);
    expect(dto.enabled).toBe(true);
    expect((dto as Record<string, unknown>).headersEnc).toBeUndefined();
    expect((dto as Record<string, unknown>).outboundSecretEnc).toBeUndefined();
  });

  it("rejects an SSRF-unsafe url", async () => {
    const u = await makeUser();
    await expect(
      createDestination(u.id, { name: "x", url: "http://169.254.169.254/" }),
    ).rejects.toThrow();
  });

  it("rejects malformed header lines", async () => {
    const u = await makeUser();
    await expect(
      createDestination(u.id, { name: "x", url: "https://example.test/", headers: "no-colon" }),
    ).rejects.toThrow();
  });

  it("get/list/delete are owner-scoped", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const d = await createDestination(a.id, { name: "A", url: "https://example.test/" });
    expect(await getDestination(b.id, d.id)).toBeNull();
    expect((await listDestinations(a.id, { limit: 25, cursor: null })).data.some((x) => x.id === d.id)).toBe(true);
    expect(await deleteDestination(b.id, d.id)).toBe(false);
    expect(await deleteDestination(a.id, d.id)).toBe(true);
  });

  it("updates timeout and url", async () => {
    const u = await makeUser();
    const d = await createDestination(u.id, { name: "A", url: "https://example.test/" });
    const up = await updateDestination(u.id, d.id, { timeoutMs: 5000, url: "https://example.test/other" });
    expect(up?.timeoutMs).toBe(5000);
    expect(up?.url).toBe("https://example.test/other");
  });

  it("no-op on empty update returns unchanged DTO", async () => {
    const u = await makeUser();
    const d = await createDestination(u.id, { name: "A", url: "https://example.test/" });
    const up = await updateDestination(u.id, d.id, {});
    expect(up?.id).toBe(d.id);
  });
});
