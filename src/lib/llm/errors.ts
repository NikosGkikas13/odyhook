// src/lib/llm/errors.ts
/** Thrown when the user has no usable AI provider configured. Replaces the old
 *  Anthropic-specific NoUserApiKeyError. Callers map it to a 400/inline error. */
export class NoLlmKeyError extends Error {
  constructor() {
    super("No AI provider configured. Add a key in Settings → API Keys.");
    this.name = "NoLlmKeyError";
  }
}
