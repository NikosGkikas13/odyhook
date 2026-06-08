import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  saveProviderKey,
  setActiveProvider,
  deleteProviderKey,
} from "@/lib/actions/api-keys";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
  openrouter: "OpenRouter",
};

export default async function ApiKeysPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const [keys, user] = await Promise.all([
    prisma.providerKey.findMany({
      where: { userId: session.user.id },
      select: { provider: true, model: true, updatedAt: true },
      orderBy: { provider: "asc" },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { activeAiProvider: true },
    }),
  ]);
  const active = user?.activeAiProvider ?? null;

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Odyhook&apos;s AI features run against <strong>your own</strong> LLM
          provider key — Anthropic, OpenAI, Google, or OpenRouter. Usage is
          billed to you, not the platform. Keys are encrypted at rest with
          AES-256-GCM. Store keys for several providers and switch the active
          one anytime.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Configured providers</h2>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-amber-600">
            No provider configured. AI features are disabled until you add one.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {keys.map((k) => (
              <li
                key={k.provider}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-100 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span>
                  <strong>{PROVIDER_LABELS[k.provider] ?? k.provider}</strong>
                  {k.model ? <span className="text-zinc-500"> · {k.model}</span> : null}
                  <span className="text-xs text-zinc-400">
                    {" "}· saved {k.updatedAt.toLocaleDateString()}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  {active === k.provider ? (
                    <span className="text-xs font-medium text-emerald-600">● active</span>
                  ) : (
                    <form action={setActiveProvider}>
                      <input type="hidden" name="provider" value={k.provider} />
                      <button type="submit" className="text-xs text-zinc-600 hover:underline dark:text-zinc-300">
                        Make active
                      </button>
                    </form>
                  )}
                  <form action={deleteProviderKey}>
                    <input type="hidden" name="provider" value={k.provider} />
                    <button type="submit" className="text-xs text-red-600 hover:underline">
                      Remove
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Add / replace a key</h2>
        <form action={saveProviderKey} className="mt-4 space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Provider</span>
            <select
              name="provider"
              defaultValue="anthropic"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google (Gemini)</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">API key</span>
            <input
              name="apiKey"
              type="password"
              required
              placeholder="sk-ant-… / sk-… / AIza… / sk-or-…"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Model <span className="text-zinc-400">(OpenRouter only)</span>
            </span>
            <input
              name="model"
              type="text"
              placeholder="meta-llama/llama-3.3-70b-instruct"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="submit"
            className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Save key
          </button>
        </form>
      </section>
    </div>
  );
}
