import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateFixture } from "./fixtures";

/** A fake Anthropic client whose messages.create returns a fixed text block. */
function fakeClient(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({ model: "model-from-api", content: [{ type: "text", text }] }),
    },
  } as unknown as Anthropic;
}

describe("generateFixture", () => {
  it("returns the parsed body and groundedOn = sample count", async () => {
    const res = await generateFixture({
      anthropic: fakeClient('```json\n{"amount":5000,"currency":"usd"}\n```'),
      prompt: "a stripe payment for $50",
      sampleBodies: ['{"id":"evt_old"}', '{"id":"evt_older"}'],
      verifyStyle: "stripe",
    });
    expect(JSON.parse(res.body)).toEqual({ amount: 5000, currency: "usd" });
    expect(res.groundedOn).toBe(2);
    expect(res.model).toBe("model-from-api");
  });

  it("works with zero samples (groundedOn = 0)", async () => {
    const res = await generateFixture({
      anthropic: fakeClient('{"ok":true}'),
      prompt: "anything",
      sampleBodies: [],
      verifyStyle: null,
    });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.groundedOn).toBe(0);
  });

  it("caps at 5 samples (groundedOn = 5)", async () => {
    const res = await generateFixture({
      anthropic: fakeClient('{"capped":true}'),
      prompt: "test",
      sampleBodies: ["{}", "{}", "{}", "{}", "{}", "{}"], // 6 supplied
      verifyStyle: null,
    });
    expect(res.groundedOn).toBe(5);
  });

  it("throws when the model returns non-JSON", async () => {
    await expect(
      generateFixture({
        anthropic: fakeClient("sorry, I cannot do that"),
        prompt: "x",
        sampleBodies: [],
        verifyStyle: null,
      }),
    ).rejects.toThrow(/valid JSON/i);
  });
});
