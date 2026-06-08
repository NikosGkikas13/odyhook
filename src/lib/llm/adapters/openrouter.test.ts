import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { openrouterAdapter } from "./openrouter";

function fake(content: string | null) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: any) => {
          calls.push(args);
          return { model: args.model, choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

describe("openrouterAdapter", () => {
  it("uses the configured model for every tier and max_tokens", async () => {
    const { client, calls } = fake("hi");
    const c = openrouterAdapter(client, "meta-llama/llama-3.3-70b-instruct");
    const res = await c.complete({
      system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 7, tier: "cheap",
    });
    expect(res).toEqual({ text: "hi", model: "meta-llama/llama-3.3-70b-instruct" });
    expect(c.provider).toBe("openrouter");
    expect(calls[0].model).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(calls[0].max_tokens).toBe(7);
    expect(calls[0].messages[0]).toEqual({ role: "system", content: "s" });
  });

  it("throws on empty content", async () => {
    const { client } = fake(null);
    await expect(
      openrouterAdapter(client, "x/y").complete({ system: "s", messages: [], maxTokens: 1, tier: "standard" }),
    ).rejects.toThrow(/no text/i);
  });
});
