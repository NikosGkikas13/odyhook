import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicAdapter } from "./anthropic";
import { PROVIDER_MODELS } from "../models";

function fake(text: string) {
  const calls: any[] = [];
  const client = {
    messages: {
      create: async (args: any) => {
        calls.push(args);
        return { model: "claude-from-api", content: [{ type: "text", text }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("anthropicAdapter", () => {
  it("maps tier → model, returns text + model", async () => {
    const { client, calls } = fake("hello");
    const c = anthropicAdapter(client);
    const res = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      tier: "standard",
    });
    expect(res).toEqual({ text: "hello", model: "claude-from-api" });
    expect(c.provider).toBe("anthropic");
    expect(calls[0].model).toBe(PROVIDER_MODELS.anthropic.standard);
    expect(calls[0].max_tokens).toBe(42);
    expect(calls[0].system).toBe("sys");
  });

  it("uses the cheap model id for tier=cheap", async () => {
    const { client, calls } = fake("x");
    await anthropicAdapter(client).complete({
      system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 10, tier: "cheap",
    });
    expect(calls[0].model).toBe(PROVIDER_MODELS.anthropic.cheap);
  });

  it("throws when no text block is returned", async () => {
    const client = {
      messages: { create: async () => ({ model: "m", content: [{ type: "tool_use" }] }) },
    } as unknown as Anthropic;
    await expect(
      anthropicAdapter(client).complete({ system: "s", messages: [], maxTokens: 1, tier: "standard" }),
    ).rejects.toThrow(/no text/i);
  });
});
