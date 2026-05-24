import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  saveAnthropicKey,
  deleteAnthropicKey,
} from "@/lib/actions/api-keys";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const existing = await prisma.userApiKey.findUnique({
    where: { userId: session.user.id },
    select: { createdAt: true, updatedAt: true },
  });

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          API Keys
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Odyhook&apos;s AI features (transformation builder, failure
          diagnostician, NL routing rules) run against Claude using{" "}
          <strong>your own</strong> Anthropic API key. Your usage is billed to
          you, not the platform. Keys are encrypted at rest with AES-256-GCM.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Anthropic API key</h2>
        {existing ? (
          <p className="mt-2 text-sm text-emerald-600">
            ✓ Key saved {existing.updatedAt.toLocaleDateString()} · AI features
            enabled.
          </p>
        ) : (
          <p className="mt-2 text-sm text-amber-600">
            No key configured. AI features are disabled until you add one.
          </p>
        )}

        <form action={saveAnthropicKey} className="mt-4 space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {existing ? "Replace key" : "Paste your key"}
            </span>
            <input
              name="apiKey"
              type="password"
              required
              placeholder="sk-ant-api03-..."
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="text-xs text-zinc-500">
              Get one at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                console.anthropic.com/settings/keys
              </a>
              .
            </span>
          </label>
          <button
            type="submit"
            className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Save key
          </button>
        </form>

        {existing && (
          <form action={deleteAnthropicKey} className="mt-4">
            <button
              type="submit"
              className="text-xs text-red-600 hover:underline"
            >
              Remove key
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
