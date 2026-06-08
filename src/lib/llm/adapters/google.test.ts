import { describe, it, expect } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import { googleAdapter } from "./google";
import { PROVIDER_MODELS } from "../models";

function fake(text: string) {
  const calls: any[] = [];
  const client = {
    models: {
      generateContent: async (args: any) => {
        calls.push(args);
        return { text };
      },
    },
  } as unknown as GoogleGenAI;
  return { client, calls };
}

describe("googleAdapter", () => {
  it("maps system→systemInstruction, messages→contents, returns text + resolved model", async () => {
    const { client, calls } = fake("hello");
    const c = googleAdapter(client);
    const res = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      tier: "standard",
    });
    expect(res).toEqual({ text: "hello", model: PROVIDER_MODELS.google.standard });
    expect(c.provider).toBe("google");
    expect(calls[0].model).toBe(PROVIDER_MODELS.google.standard);
    expect(calls[0].config.systemInstruction).toBe("sys");
    expect(calls[0].config.maxOutputTokens).toBe(42);
    expect(calls[0].contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
  });

  it("throws on empty text", async () => {
    const { client } = fake("");
    await expect(
      googleAdapter(client).complete({ system: "s", messages: [], maxTokens: 1, tier: "cheap" }),
    ).rejects.toThrow(/no text/i);
  });
});
