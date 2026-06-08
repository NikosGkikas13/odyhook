import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../types";
import { PROVIDER_MODELS } from "../models";

/** Wrap a constructed Anthropic SDK client as an LlmClient. */
export function anthropicAdapter(client: Anthropic): LlmClient {
  return {
    provider: "anthropic",
    async complete({ system, messages, maxTokens, tier }) {
      const model = PROVIDER_MODELS.anthropic[tier];
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });
      const block = res.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        throw new Error("anthropic: no text content returned");
      }
      return { text: block.text, model: res.model };
    },
  };
}
