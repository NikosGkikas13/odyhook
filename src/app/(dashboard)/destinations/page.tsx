import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  createDestination,
  deleteDestination,
  toggleDestinationEnabled,
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

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
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
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">URL</span>
            <input
              name="url"
              type="url"
              required
              placeholder="https://api.example.com/webhooks/stripe"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
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
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-zinc-600 dark:text-zinc-400">
              Outbound signing secret (optional)
            </span>
            <input
              name="outboundSecret"
              type="password"
              autoComplete="off"
              placeholder="paste a strong shared secret (16+ chars) to enable HMAC signing"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="text-xs text-zinc-500">
              When set, every delivery to this URL carries
              <code className="mx-1">X-Odyhook-Signature: v1=&lt;hex&gt;</code>
              and <code>X-Odyhook-Timestamp</code>. Verify with
              <code className="mx-1">HMAC-SHA256(secret, `${"${timestamp}"}.${"${body}"}`)</code>.
              Stored encrypted; we can&apos;t show it back to you.
            </span>
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
            >
              Create destination
            </button>
          </div>
        </form>
      </section>

      <section>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3 text-right">Timeout</th>
                <th className="px-4 py-3 text-right">Routes</th>
                <th className="px-4 py-3 text-right">Deliveries</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {destinations.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-zinc-500"
                  >
                    No destinations yet. Create one above.
                  </td>
                </tr>
              ) : (
                destinations.map((d) => (
                  <tr
                    key={d.id}
                    className={`border-b border-zinc-100 dark:border-zinc-800 ${d.enabled ? "" : "opacity-60"}`}
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
                    <td className="px-4 py-3">
                      <span
                        className={
                          d.enabled
                            ? "inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                        }
                      >
                        {d.enabled ? "Active" : "Paused"}
                      </span>
                      {d.outboundSecretEnc ? (
                        <span
                          title="Outbound HMAC signing enabled"
                          className="ml-2 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        >
                          Signed
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-3">
                        <form action={toggleDestinationEnabled}>
                          <input type="hidden" name="id" value={d.id} />
                          <button
                            type="submit"
                            className="text-xs text-zinc-600 hover:underline dark:text-zinc-300"
                          >
                            {d.enabled ? "Pause" : "Resume"}
                          </button>
                        </form>
                        <form action={deleteDestination}>
                          <input type="hidden" name="id" value={d.id} />
                          <button
                            type="submit"
                            className="text-xs text-red-600 hover:underline"
                          >
                            Delete
                          </button>
                        </form>
                      </div>
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
