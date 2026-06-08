import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

import type { LlmClient, Provider } from "./types";
import { NoLlmKeyError } from "./errors";
import { OPENROUTER_BASE_URL } from "./models";
import { anthropicAdapter } from "./adapters/anthropic";
import { openaiAdapter } from "./adapters/openai";
import { openrouterAdapter } from "./adapters/openrouter";
import { googleAdapter } from "./adapters/google";

export type { LlmClient, Provider, Tier } from "./types";
export { NoLlmKeyError } from "./errors";
export { PROVIDER_MODELS } from "./models";

export type LlmConfig = {
  provider: Provider;
  apiKey: string;
  model?: string | null; // OpenRouter only
};

/** Pure: construct the SDK client + adapter for a provider config. No DB. */
export function buildLlmClient(cfg: LlmConfig): LlmClient {
  switch (cfg.provider) {
    case "anthropic":
      return anthropicAdapter(new Anthropic({ apiKey: cfg.apiKey }));
    case "openai":
      return openaiAdapter(new OpenAI({ apiKey: cfg.apiKey }));
    case "openrouter":
      if (!cfg.model) throw new NoLlmKeyError();
      return openrouterAdapter(
        new OpenAI({ apiKey: cfg.apiKey, baseURL: OPENROUTER_BASE_URL }),
        cfg.model,
      );
    case "google":
      return googleAdapter(new GoogleGenAI({ apiKey: cfg.apiKey }));
    default:
      throw new NoLlmKeyError();
  }
}

/**
 * Build an LlmClient for a user's active provider (bring-your-own-key).
 * Throws NoLlmKeyError if no provider is active or its key is unusable.
 */
export async function llmFor(userId: string): Promise<LlmClient> {
  // Lazy imports keep this module free of top-level DB/crypto side-effects,
  // so buildLlmClient tests can import without a DATABASE_URL.
  const { prisma } = await import("@/lib/prisma");
  const { decrypt } = await import("@/lib/crypto");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeAiProvider: true },
  });
  const provider = user?.activeAiProvider as Provider | null | undefined;
  if (!provider) throw new NoLlmKeyError();

  const row = await prisma.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row) throw new NoLlmKeyError();

  let apiKey: string;
  try {
    apiKey = decrypt(row.keyEnc);
  } catch {
    throw new NoLlmKeyError();
  }
  return buildLlmClient({ provider, apiKey, model: row.model });
}
