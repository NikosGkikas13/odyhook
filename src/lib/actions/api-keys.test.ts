import { describe, it, expect, vi } from "vitest";

// validateProviderKey is pure; mock out the server-only imports so the
// module loads cleanly in the Vitest (Node) environment.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => s }));

import { validateProviderKey } from "./api-keys";

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
