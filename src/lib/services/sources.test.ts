// src/lib/services/sources.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createSource, getSource, listSources, updateSource, deleteSource } from "./sources";

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
    expect(dto.slug).toMatch(/^[a-z0-9_-]+$/);
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
});
