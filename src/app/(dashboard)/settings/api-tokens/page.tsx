import { auth } from "@/auth";
import { listTokensForUser } from "@/lib/services/api-tokens";
import { CreateTokenForm } from "./create-token-form";
import { RevokeButton } from "./revoke-button";

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const tokens = await listTokensForUser(session.user.id);

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API Tokens</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Authenticate to the Odyhook REST API (
          <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
            /api/v1
          </code>
          ) by passing a token in the{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
            Authorization: Bearer &lt;token&gt;
          </code>{" "}
          header. Tokens grant full access to your account — treat them like
          passwords.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Create a new token</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Give the token a memorable name (e.g.&nbsp;<em>my-laptop</em>,{" "}
          <em>ci-pipeline</em>). The raw value is shown only once after
          creation.
        </p>
        <div className="mt-4">
          <CreateTokenForm />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Your tokens</h2>
        <ul className="divide-y rounded-lg border border-zinc-200 dark:border-zinc-700">
          {tokens.length === 0 && (
            <li className="p-4 text-sm text-zinc-500">No tokens yet.</li>
          )}
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0 text-sm">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{t.name}</span>
                  <span className="font-mono text-xs text-zinc-500">
                    {t.prefix}&hellip;
                  </span>
                  {t.revokedAt && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      revoked
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  Last used:{" "}
                  {t.lastUsedAt
                    ? new Date(t.lastUsedAt).toLocaleDateString()
                    : "never"}{" "}
                  &middot; Created:{" "}
                  {new Date(t.createdAt).toLocaleDateString()}
                </div>
              </div>
              {!t.revokedAt && <RevokeButton id={t.id} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
