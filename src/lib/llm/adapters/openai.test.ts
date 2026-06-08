import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { openaiAdapter } from "./openai";
import { PROVIDER_MODELS } from "../models";

function fake(content: string | null) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: any) => {
          calls.push(args);
          return { model: "gpt-from-api", choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

describe("openaiAdapter", () => {
  it("prepends the system message and returns text + model", async () => {
    const { client, calls } = fake("hello");
    const c = openaiAdapter(client);
    const res = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      tier: "standard",
    });
    expect(res).toEqual({ text: "hello", model: "gpt-from-api" });
    expect(c.provider).toBe("openai");
    expect(calls[0].model).toBe(PROVIDER_MODELS.openai.standard);
    expect(calls[0].max_completion_tokens).toBe(42);
    expect(calls[0].messages[0]).toEqual({ role: "system", content: "sys" });
    expect(calls[0].messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("throws when the model returns empty content", async () => {
    const { client } = fake(null);
    await expect(
      openaiAdapter(client).complete({ system: "s", messages: [], maxTokens: 1, tier: "cheap" }),
    ).rejects.toThrow(/no text/i);
  });
});
