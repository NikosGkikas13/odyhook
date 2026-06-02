import Anthropic from "@anthropic-ai/sdk";

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";

export { MODEL_DEFAULT, MODEL_CHEAP } from "@/lib/ai/models";

export class NoUserApiKeyError extends Error {
  constructor() {
    super(
      "No Anthropic API key configured. Set one in Settings → API Keys.",
    );
    this.name = "NoUserApiKeyError";
  }
}

/**
 * Load a user's decrypted Anthropic API key, or null if they haven't set one.
 */
export async function getUserApiKey(userId: string): Promise<string | null> {
  const row = await prisma.userApiKey.findUnique({ where: { userId } });
  if (!row) return null;
  try {
    return decrypt(row.anthropicKeyEnc);
  } catch {
    return null;
  }
}

/**
 * Create an Anthropic client on behalf of a user (bring-your-own-key).
 * Throws NoUserApiKeyError if the user hasn't configured a key.
 */
export async function anthropicFor(userId: string): Promise<Anthropic> {
  const apiKey = await getUserApiKey(userId);
  if (!apiKey) {
    throw new NoUserApiKeyError();
  }
  return new Anthropic({ apiKey });
}
