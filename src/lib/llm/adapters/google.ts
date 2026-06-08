import type { GoogleGenAI } from "@google/genai";
import type { LlmClient } from "../types";
import { PROVIDER_MODELS } from "../models";

/** Wrap a constructed @google/genai client as an LlmClient. */
export function googleAdapter(client: GoogleGenAI): LlmClient {
  return {
    provider: "google",
    async complete({ system, messages, maxTokens, tier }) {
      const model = PROVIDER_MODELS.google[tier];
      const res = await client.models.generateContent({
        model,
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        config: { systemInstruction: system, maxOutputTokens: maxTokens },
      });
      const text = res.text;
      if (!text) throw new Error("google: no text content returned");
      return { text, model };
    },
  };
}
