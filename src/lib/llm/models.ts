// src/lib/llm/models.ts
// Curated (standard, cheap) model pair per native provider. Kept dependency-free
// so adapters and their tests can import without pulling in the DB client.
// OpenRouter has no entry — the user supplies one model id, used for both tiers.
import type { NativeProvider, Tier } from "./types";

export const PROVIDER_MODELS: Record<NativeProvider, Record<Tier, string>> = {
  anthropic: { standard: "claude-sonnet-4-6", cheap: "claude-haiku-4-5-20251001" },
  openai: { standard: "gpt-5", cheap: "gpt-5-mini" },
  google: { standard: "gemini-2.5-pro", cheap: "gemini-2.5-flash" },
};

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
