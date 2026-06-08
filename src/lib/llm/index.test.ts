import { describe, it, expect } from "vitest";
import { buildLlmClient } from "./index";
import { NoLlmKeyError } from "./errors";

describe("buildLlmClient", () => {
  it("builds a client per provider with the right provider tag", () => {
    expect(buildLlmClient({ provider: "anthropic", apiKey: "sk-ant-x" }).provider).toBe("anthropic");
    expect(buildLlmClient({ provider: "openai", apiKey: "sk-x" }).provider).toBe("openai");
    expect(buildLlmClient({ provider: "google", apiKey: "AIzax" }).provider).toBe("google");
    expect(
      buildLlmClient({ provider: "openrouter", apiKey: "sk-or-x", model: "x/y" }).provider,
    ).toBe("openrouter");
  });

  it("throws NoLlmKeyError when OpenRouter has no model", () => {
    expect(() => buildLlmClient({ provider: "openrouter", apiKey: "sk-or-x", model: null })).toThrow(
      NoLlmKeyError,
    );
  });
});
