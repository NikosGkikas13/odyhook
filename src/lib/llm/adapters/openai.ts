import type OpenAI from "openai";
import type { LlmClient } from "../types";
import { PROVIDER_MODELS } from "../models";

/** Wrap a constructed OpenAI SDK client as an LlmClient (Chat Completions). */
export function openaiAdapter(client: OpenAI): LlmClient {
  return {
    provider: "openai",
    async complete({ system, messages, maxTokens, tier }) {
      const model = PROVIDER_MODELS.openai[tier];
      const res = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
      });
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("openai: no text content returned");
      return { text, model: res.model };
    },
  };
}
