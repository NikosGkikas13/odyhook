import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { explainEventDiff, canonicalPair, EventDiffError } from "./event-diff";

/** A fake Anthropic client whose messages.create returns a fixed text block
 *  and records the last request so tests can assert what was sent. */
function fakeClient(text: string) {
  const calls: Array<{ system?: unknown; messages: unknown }> = [];
  const client = {
    messages: {
      create: async (args: { system?: unknown; messages: unknown }) => {
        calls.push({ system: args.system, messages: args.messages });
        return { model: "model-from-api", content: [{ type: "text", text }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const VALID = JSON.stringify({
  summary: "amount rose and a coupon was added",
  changes: [
    { path: "$.amount", kind: "changed", from: "500", to: "1200" },
    { path: "$.metadata.coupon", kind: "added", to: "SAVE20" },
  ],
});

describe("explainEventDiff", () => {
  it("returns the parsed summary, changes, and model", async () => {
    const { client } = fakeClient(VALID);
    const res = await explainEventDiff({
      anthropic: client,
      bodyA: '{"amount":500}',
      bodyB: '{"amount":1200,"metadata":{"coupon":"SAVE20"}}',
    });
    expect(res.summary).toMatch(/amount/i);
    expect(res.changes).toHaveLength(2);
    expect(res.changes[0]).toEqual({
      path: "$.amount",
      kind: "changed",
      from: "500",
      to: "1200",
    });
    expect(res.modelUsed).toBe("model-from-api");
  });

  it("parses fenced JSON output", async () => {
    const { client } = fakeClient("```json\n" + VALID + "\n```");
    const res = await explainEventDiff({
      anthropic: client,
      bodyA: "{}",
      bodyB: "{}",
    });
    expect(res.changes).toHaveLength(2);
  });

  it("throws EventDiffError on non-JSON output", async () => {
    const { client } = fakeClient("sorry, I can't compare these");
    await expect(
      explainEventDiff({ anthropic: client, bodyA: "{}", bodyB: "{}" }),
    ).rejects.toThrow(EventDiffError);
  });

  it("caps each body to MAX_BODY_CHARS before sending", async () => {
    const huge = '{"x":"' + "a".repeat(20000) + '"}';
    const { client, calls } = fakeClient(VALID);
    await explainEventDiff({ anthropic: client, bodyA: huge, bodyB: huge });
    const sent = JSON.stringify(calls[0].messages);
    // Neither embedded body should carry the full 20k payload.
    expect(sent.length).toBeLessThan(20000);
  });

  it("throws EventDiffError when model returns the literal null", async () => {
    const { client } = fakeClient("null");
    await expect(
      explainEventDiff({ anthropic: client, bodyA: "{}", bodyB: "{}" }),
    ).rejects.toThrow(EventDiffError);
  });

  it("filters null items in the changes array and enforces from/to contract", async () => {
    const { client } = fakeClient(
      '{"summary":"x","changes":[null,{"path":"$.a","kind":"added","to":"1"}]}',
    );
    const res = await explainEventDiff({
      anthropic: client,
      bodyA: "{}",
      bodyB: '{"a":"1"}',
    });
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toEqual({ path: "$.a", kind: "added", to: "1" });
  });
});

describe("canonicalPair", () => {
  it("orders older event as A regardless of argument order", () => {
    const older = { id: "old", receivedAt: new Date("2026-01-01") };
    const newer = { id: "new", receivedAt: new Date("2026-02-01") };
    expect(canonicalPair(newer, older)).toEqual({
      olderId: "old",
      newerId: "new",
    });
    expect(canonicalPair(older, newer)).toEqual({
      olderId: "old",
      newerId: "new",
    });
  });

  it("breaks ties by id when receivedAt is equal", () => {
    const t = new Date("2026-01-01");
    const a = { id: "aaa", receivedAt: t };
    const b = { id: "bbb", receivedAt: t };
    expect(canonicalPair(b, a)).toEqual({ olderId: "aaa", newerId: "bbb" });
    expect(canonicalPair(a, b)).toEqual({ olderId: "aaa", newerId: "bbb" });
  });
});
