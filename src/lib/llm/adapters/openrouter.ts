import type OpenAI from "openai";
import type { LlmClient } from "../types";

/** Wrap an OpenAI SDK client pointed at OpenRouter. The user's single chosen
 *  model id is used for both tiers (OpenRouter is an aggregator). */
export function openrouterAdapter(client: OpenAI, model: string): LlmClient {
  return {
    provider: "openrouter",
    async complete({ system, messages, maxTokens }) {
      const res = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
      });
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("openrouter: no text content returned");
      return { text, model: res.model ?? model };
    },
  };
}
