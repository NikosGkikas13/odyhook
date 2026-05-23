import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  createDestination,
  deleteDestination,
} from "@/lib/actions/destinations";

export const dynamic = "force-dynamic";

export default async function DestinationsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const destinations = await prisma.destination.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { routes: true, deliveries: true } } },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Destinations</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Forwarding targets. Optionally attach static headers — they&apos;re
          encrypted at rest.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-medium">New destination</h2>
        <form
          action={createDestination}
          className="mt-4 grid gap-4 sm:grid-cols-2"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Name</span>
            <input
              name="name"
              required
              placeholder="Billing service (prod)"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">URL</span>
            <input
              name="url"
              type="url"
              required
              placeholder="https://api.example.com/webhooks/stripe"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Timeout (ms)
            </span>
            <input
              name="timeoutMs"
              type="number"
              defaultValue={10000}
              min={1000}
              max={60000}
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-zinc-600 dark:text-zinc-400">
              Headers (one per line, <code>Key: Value</code>)
            </span>
            <textarea
              name="headers"
              rows={3}
              placeholder={"Authorization: Bearer …\nX-Api-Key: …"}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              style={{ background: "var(--brand-navy)" }}
            className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              Create destination
            </button>
          </div>
        </form>
      </section>

      <section>
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3 text-right">Timeout</th>
                <th className="px-4 py-3 text-right">Routes</th>
                <th className="px-4 py-3 text-right">Deliveries</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {destinations.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-zinc-500"
                  >
                    No destinations yet. Create one above.
                  </td>
                </tr>
              ) : (
                destinations.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-zinc-100 dark:border-zinc-900"
                  >
                    <td className="px-4 py-3 font-medium">{d.name}</td>
                    <td className="px-4 py-3">
                      <code className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {d.url}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {d.timeoutMs}ms
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {d._count.routes}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {d._count.deliveries}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={deleteDestination}>
                        <input type="hidden" name="id" value={d.id} />
                        <button
                          type="submit"
                          className="text-xs text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
