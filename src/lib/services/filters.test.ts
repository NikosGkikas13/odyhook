import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai/rule-compiler", () => ({
  compileRule: vi.fn(async () => ({
    ast: { exists: "$.id" },
    matchedCount: 2,
    totalCount: 3,
    sampleMatches: [],
  })),
}));

import { prisma } from "@/lib/prisma";
import { compileRule } from "@/lib/ai/rule-compiler";
import { compileFilterForSource } from "./filters";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const user = await prisma.user.create({ data: { email: `${uniq("cf")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("cf-s") } });
  await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: JSON.stringify({ id: "evt_1" }) } });
  return { user, source };
}

describe("compileFilterForSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads recent samples and returns the compiled preview", async () => {
    const { user, source } = await setup();
    const out = await compileFilterForSource(user.id, source.id, "events with an id");
    expect(out).toEqual({ ast: { exists: "$.id" }, matchedCount: 2, totalCount: 3 });
    expect(compileRule).toHaveBeenCalledWith(user.id, "events with an id", expect.any(Array));
  });

  it("throws not found for a source the user does not own", async () => {
    const a = await setup();
    const b = await setup();
    await expect(compileFilterForSource(b.user.id, a.source.id, "x")).rejects.toThrow(/not found/i);
  });

  it("calls compileRule with an empty samples array when the source has no events", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("cf0")}@test.local` } });
    const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("cf0-s") } });
    await compileFilterForSource(user.id, source.id, "anything");
    expect(compileRule).toHaveBeenCalledWith(user.id, "anything", []);
  });

  it("falls back to { raw } for an event body that is not valid JSON", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("cfr")}@test.local` } });
    const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("cfr-s") } });
    await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "not-json" } });
    await compileFilterForSource(user.id, source.id, "anything");
    expect(compileRule).toHaveBeenCalledWith(user.id, "anything", [{ raw: "not-json" }]);
  });
});
