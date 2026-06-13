import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { deleteSource } from "@/lib/actions/sources";
import { NewSourceForm } from "./new-source-form";

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
        <NewSourceForm />
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
                      <td className="px-4 py-3 font-medium">
                        <Link
                          href={`/sources/${s.id}`}
                          className="text-zinc-900 hover:underline dark:text-zinc-100"
                        >
                          {s.name}
                        </Link>
                      </td>
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
