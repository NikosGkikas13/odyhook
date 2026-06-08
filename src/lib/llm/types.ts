// src/lib/llm/types.ts
// The provider-agnostic surface every AI feature talks to. Shaped to exactly
// what the modules already do: a system prompt + user turns in, one text block
// out (plus the model id, which a few features persist).

export type Provider = "anthropic" | "openai" | "google" | "openrouter";

/** Native providers with a curated (standard, cheap) model pair. OpenRouter is
 *  excluded — the user names a single model used for both tiers. */
export type NativeProvider = Exclude<Provider, "openrouter">;

export type Tier = "standard" | "cheap";

export type LlmMessage = { role: "user" | "assistant"; content: string };

export type CompleteArgs = {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  tier: Tier; // adapter resolves tier → concrete model id
};

export type CompleteResult = {
  /** The model's text output (the single text block). */
  text: string;
  /** The concrete model id that produced it (persisted by some features). */
  model: string;
};

export interface LlmClient {
  readonly provider: Provider;
  complete(args: CompleteArgs): Promise<CompleteResult>;
}
