import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { compileSearchQuery, SearchCompileError } from "./search-compiler";

function fakeClient(text: string) {
  const calls: Array<{ system?: unknown; messages: unknown }> = [];
  const client = {
    messages: {
      create: async (args: { system?: unknown; messages: unknown }) => {
        calls.push({ system: args.system, messages: args.messages });
        return { model: "m", content: [{ type: "text", text }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const sources = [{ id: "src_stripe", name: "Stripe", slug: "stripe" }];
const VALID = JSON.stringify({
  metadata: { sourceId: "src_stripe", receivedAfter: "2026-05-31T00:00:00.000Z", receivedBefore: "2026-06-01T00:00:00.000Z", status: ["failed"] },
  payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] },
});

describe("compileSearchQuery", () => {
  it("returns a validated query and summary chips", async () => {
    const { client } = fakeClient(VALID);
    const res = await compileSearchQuery({
      anthropic: client, prompt: "failed stripe events yesterday from gmail users",
      sources, sampleBodies: ['{"data":{"object":{"customer":{"email":"a@gmail.com"}}}}'],
      now: new Date("2026-06-01T12:00:00Z"),
    });
    expect(res.query.metadata.sourceId).toBe("src_stripe");
    expect(res.query.payload).toEqual({ endsWith: ["$.data.object.customer.email", "@gmail.com"] });
    expect(res.summary.some((c) => /source: Stripe/.test(c))).toBe(true);
  });

  it("parses fenced JSON", async () => {
    const { client } = fakeClient("```json\n" + VALID + "\n```");
    const res = await compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] });
    expect(res.query.metadata.status).toEqual(["failed"]);
  });

  it("coerces a foreign/unknown sourceId to null", async () => {
    const { client } = fakeClient(JSON.stringify({
      metadata: { sourceId: "src_someone_else", receivedAfter: null, receivedBefore: null, status: null },
      payload: null,
    }));
    const res = await compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] });
    expect(res.query.metadata.sourceId).toBeNull();
  });

  it("throws SearchCompileError on non-JSON output", async () => {
    const { client } = fakeClient("sorry, I can't do that");
    await expect(compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] })).rejects.toThrow(SearchCompileError);
  });

  it("throws SearchCompileError on a structurally invalid query", async () => {
    const { client } = fakeClient(JSON.stringify({ metadata: { status: ["nope"] }, payload: null }));
    await expect(compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] })).rejects.toThrow(SearchCompileError);
  });
});
