// src/lib/services/sources.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createSource, getSource, listSources, updateSource, deleteSource, randomSlug } from "./sources";

async function makeUser() {
  return prisma.user.create({
    data: { email: `src-svc-${Date.now()}-${Math.random()}@test.local` },
  });
}

describe("sources service", () => {
  it("creates a source, returns a secret-free DTO with a slug", async () => {
    const u = await makeUser();
    const dto = await createSource(u.id, { name: "Stripe", verifyStyle: "stripe", signingSecret: "whsec_123" });
    expect(dto.name).toBe("Stripe");
    expect(dto.verifyStyle).toBe("stripe");
    expect(dto.hasSigningSecret).toBe(true);
    expect(dto.slug).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((dto as Record<string, unknown>).signingSecret).toBeUndefined();
  });

  it("requires a signing secret when verifyStyle is set", async () => {
    const u = await makeUser();
    await expect(createSource(u.id, { name: "x", verifyStyle: "github" })).rejects.toThrow();
  });

  it("lists only the owner's sources and gets by id scoped to owner", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const sa = await createSource(a.id, { name: "A", verifyStyle: "none" });
    await createSource(b.id, { name: "B", verifyStyle: "none" });
    const list = await listSources(a.id, { limit: 25, cursor: null });
    expect(list.data.map((s) => s.id)).toContain(sa.id);
    expect(list.data.every((s) => s.name !== "B")).toBe(true);
    expect(await getSource(b.id, sa.id)).toBeNull(); // cross-owner read denied
  });

  it("updates name and clears verification", async () => {
    const u = await makeUser();
    const s = await createSource(u.id, { name: "A", verifyStyle: "stripe", signingSecret: "whsec_1" });
    const up = await updateSource(u.id, s.id, { name: "B", verifyStyle: "none" });
    expect(up?.name).toBe("B");
    expect(up?.verifyStyle).toBeNull();
    expect(up?.hasSigningSecret).toBe(false);
  });

  it("delete is owner-scoped (no-op for non-owner) ", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const s = await createSource(a.id, { name: "A", verifyStyle: "none" });
    expect(await deleteSource(b.id, s.id)).toBe(false);
    expect(await deleteSource(a.id, s.id)).toBe(true);
    expect(await getSource(a.id, s.id)).toBeNull();
  });

  it("rotating verifyStyle between non-none values without a new secret keeps the existing secret", async () => {
    const u = await makeUser();
    const s = await createSource(u.id, { name: "S", verifyStyle: "stripe", signingSecret: "whsec_abc" });
    expect(s.hasSigningSecret).toBe(true);
    const up = await updateSource(u.id, s.id, { verifyStyle: "github" });
    expect(up?.verifyStyle).toBe("github");
    expect(up?.hasSigningSecret).toBe(true);
  });

  it("an empty update returns the unchanged DTO without throwing", async () => {
    const u = await makeUser();
    const s = await createSource(u.id, { name: "Unchanged", verifyStyle: "none" });
    const up = await updateSource(u.id, s.id, {});
    expect(up?.id).toBe(s.id);
    expect(up?.name).toBe("Unchanged");
  });
});

describe("randomSlug", () => {
  it("carries >=128 bits of entropy (>=22 base64url chars)", () => {
    const s = randomSlug();
    // 16 random bytes -> 22 unpadded base64url chars (the old 6 bytes was ~48 bits).
    expect(s.length).toBeGreaterThanOrEqual(22);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not collide across many draws", () => {
    const draws = Array.from({ length: 2000 }, () => randomSlug());
    expect(new Set(draws).size).toBe(draws.length);
  });
});
