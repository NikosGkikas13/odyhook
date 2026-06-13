import { describe, it, expect } from "vitest";

import { validateProviderKey } from "./validate-key";

describe("validateProviderKey", () => {
  it("accepts well-formed keys per provider", () => {
    expect(validateProviderKey("anthropic", "sk-ant-abc", null)).toEqual({ ok: true });
    expect(validateProviderKey("openai", "sk-abc", null)).toEqual({ ok: true });
    expect(validateProviderKey("google", "AIzaABC", null)).toEqual({ ok: true });
    expect(validateProviderKey("openrouter", "sk-or-abc", "meta/llama")).toEqual({ ok: true });
  });

  it("rejects an unknown provider", () => {
    expect(validateProviderKey("grok", "x", null).ok).toBe(false);
  });

  it("rejects a wrong prefix", () => {
    expect(validateProviderKey("anthropic", "sk-abc", null).ok).toBe(false);
    expect(validateProviderKey("openai", "ghp_abc", null).ok).toBe(false);
  });

  it("requires a model for OpenRouter", () => {
    expect(validateProviderKey("openrouter", "sk-or-abc", "").ok).toBe(false);
    expect(validateProviderKey("openrouter", "sk-or-abc", null).ok).toBe(false);
  });
});
