import { describe, it, expect } from "vitest";
import type { LlmClient } from "@/lib/llm";
import { compileSearchQuery, SearchCompileError } from "./search-compiler";

function fakeLlm(text: string): LlmClient {
  return {
    provider: "anthropic",
    complete: async () => ({ text, model: "test-model" }),
  };
}

const sources = [{ id: "src_stripe", name: "Stripe", slug: "stripe" }];
const VALID = JSON.stringify({
  metadata: { sourceId: "src_stripe", receivedAfter: "2026-05-31T00:00:00.000Z", receivedBefore: "2026-06-01T00:00:00.000Z", status: ["failed"] },
  payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] },
});

describe("compileSearchQuery", () => {
  it("returns a validated query and summary chips", async () => {
    const res = await compileSearchQuery({
      llm: fakeLlm(VALID), prompt: "failed stripe events yesterday from gmail users",
      sources, sampleBodies: ['{"data":{"object":{"customer":{"email":"a@gmail.com"}}}}'],
      now: new Date("2026-06-01T12:00:00Z"),
    });
    expect(res.query.metadata.sourceId).toBe("src_stripe");
    expect(res.query.payload).toEqual({ endsWith: ["$.data.object.customer.email", "@gmail.com"] });
    expect(res.summary.some((c) => /source: Stripe/.test(c))).toBe(true);
  });

  it("parses fenced JSON", async () => {
    const res = await compileSearchQuery({ llm: fakeLlm("```json\n" + VALID + "\n```"), prompt: "x", sources, sampleBodies: [] });
    expect(res.query.metadata.status).toEqual(["failed"]);
  });

  it("coerces a foreign/unknown sourceId to null", async () => {
    const res = await compileSearchQuery({
      llm: fakeLlm(JSON.stringify({
        metadata: { sourceId: "src_someone_else", receivedAfter: null, receivedBefore: null, status: null },
        payload: null,
      })),
      prompt: "x", sources, sampleBodies: [],
    });
    expect(res.query.metadata.sourceId).toBeNull();
  });

  it("throws SearchCompileError on non-JSON output", async () => {
    await expect(compileSearchQuery({ llm: fakeLlm("sorry, I can't do that"), prompt: "x", sources, sampleBodies: [] })).rejects.toThrow(SearchCompileError);
  });

  it("throws SearchCompileError on a structurally invalid query", async () => {
    await expect(compileSearchQuery({ llm: fakeLlm(JSON.stringify({ metadata: { status: ["nope"] }, payload: null })), prompt: "x", sources, sampleBodies: [] })).rejects.toThrow(SearchCompileError);
  });
});
