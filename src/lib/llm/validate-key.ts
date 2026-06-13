import type { Provider } from "./types";

// Pure, dependency-free validation for a BYOK provider key. Lives outside the
// `"use server"` action module on purpose: a server-action file may only export
// async Server Functions, so a synchronous helper exported from there breaks
// `next build`. Importing this anywhere (server, edge, test) is safe.

const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

// Order matters: openrouter's "sk-or-" is a superset of openai's "sk-".
const PREFIX: Record<Provider, string> = {
  anthropic: "sk-ant-",
  openrouter: "sk-or-",
  openai: "sk-",
  google: "AIza",
};

export function validateProviderKey(
  provider: string,
  key: string,
  model: string | null,
): { ok: true } | { ok: false; error: string } {
  if (!PROVIDERS.includes(provider as Provider)) {
    return { ok: false, error: "Unknown provider." };
  }
  const p = provider as Provider;
  if (!key.startsWith(PREFIX[p])) {
    return { ok: false, error: `That doesn't look like a ${p} key (expected ${PREFIX[p]}…).` };
  }
  if (p === "openrouter" && !model?.trim()) {
    return { ok: false, error: "OpenRouter requires a model id (e.g. meta-llama/llama-3.3-70b-instruct)." };
  }
  return { ok: true };
}
