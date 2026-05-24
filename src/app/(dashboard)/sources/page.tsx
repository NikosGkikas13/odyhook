import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createSource, deleteSource } from "@/lib/actions/sources";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const sources = await prisma.source.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { events: true, routes: true } },
    },
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Each source has a unique ingest URL. Point external services at it.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">New source</h2>
        <form action={createSource} className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Name</span>
            <input
              name="name"
              required
              placeholder="Stripe (prod)"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Signature verification
            </span>
            <select
              name="verifyStyle"
              defaultValue="none"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="none">None</option>
              <option value="stripe">Stripe</option>
              <option value="github">GitHub</option>
              <option value="generic-sha256">Generic SHA-256</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-zinc-600 dark:text-zinc-400">
              Signing secret (only needed if verification is enabled)
            </span>
            <input
              name="signingSecret"
              type="password"
              placeholder="whsec_..."
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
            >
              Create source
            </button>
          </div>
        </form>
      </section>

      <section>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Ingest URL</th>
                <th className="px-4 py-3">Verify</th>
                <th className="px-4 py-3 text-right">Events</th>
                <th className="px-4 py-3 text-right">Routes</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-zinc-500"
                  >
                    No sources yet. Create one above.
                  </td>
                </tr>
              ) : (
                sources.map((s) => {
                  const url = `${baseUrl}/api/ingest/${s.slug}`;
                  return (
                    <tr
                      key={s.id}
                      className="border-b border-zinc-100 dark:border-zinc-800"
                    >
                      <td className="px-4 py-3 font-medium">{s.name}</td>
                      <td className="px-4 py-3">
                        <code className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {url}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-zinc-500">
                        {s.verifyStyle ?? "none"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {s._count.events}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {s._count.routes}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <form action={deleteSource}>
                          <input type="hidden" name="id" value={s.id} />
                          <button
                            type="submit"
                            className="text-xs text-red-600 hover:underline"
                          >
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
