import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadSearchContext, compileSearchForUser } from "./search";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("loadSearchContext", () => {
  it("returns the user's sources and recent sample bodies", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("ctx")}@test.local` } });
    const source = await prisma.source.create({ data: { userId: user.id, name: "Stripe", slug: uniq("ctx-s") } });
    await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: '{"a":1}' } });

    const ctx = await loadSearchContext(user.id);
    expect(ctx.sources.map((s) => s.id)).toContain(source.id);
    expect(ctx.sampleBodies).toContain('{"a":1}');
  });

  it("does not leak another user's sources", async () => {
    const a = await prisma.user.create({ data: { email: `${uniq("ctxa")}@test.local` } });
    const b = await prisma.user.create({ data: { email: `${uniq("ctxb")}@test.local` } });
    const sb = await prisma.source.create({ data: { userId: b.id, name: "B", slug: uniq("ctxb-s") } });
    const ctx = await loadSearchContext(a.id);
    expect(ctx.sources.map((s) => s.id)).not.toContain(sb.id);
  });
});

describe("compileSearchForUser", () => {
  it("throws when the user has no AI provider key", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("nokey")}@test.local` } });
    await expect(compileSearchForUser(user.id, "anything")).rejects.toThrow(/No AI provider configured/i);
  });
});
