import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { RouteToggle } from "@/components/route-toggle";

export const dynamic = "force-dynamic";

export default async function RoutesPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const [sources, destinations, routes] = await Promise.all([
    prisma.source.findMany({
      where: { userId: session.user.id },
      orderBy: { name: "asc" },
    }),
    prisma.destination.findMany({
      where: { userId: session.user.id },
      orderBy: { name: "asc" },
    }),
    prisma.route.findMany({
      where: { source: { userId: session.user.id } },
      include: {
        source: { select: { name: true } },
        destination: { select: { name: true } },
        transformation: { select: { id: true } },
      },
    }),
  ]);

  const enabledRoutes = routes.filter((r) => r.enabled);

  const routeMap = new Map<string, { id: string; enabled: boolean }>();
  for (const r of routes) {
    routeMap.set(`${r.sourceId}:${r.destinationId}`, {
      id: r.id,
      enabled: r.enabled,
    });
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Routes</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Check a cell to fan out events from a source to a destination.
          Uncheck to disable.
        </p>
      </div>

      {sources.length === 0 || destinations.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          You need at least one source and one destination to create routes.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Source \\ Destination</th>
                {destinations.map((d) => (
                  <th key={d.id} className="px-4 py-3 text-center">
                    {d.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-zinc-100 dark:border-zinc-900"
                >
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  {destinations.map((d) => {
                    const r = routeMap.get(`${s.id}:${d.id}`);
                    const enabled = !!r?.enabled;
                    return (
                      <td key={d.id} className="px-4 py-3 text-center">
                        <RouteToggle
                          sourceId={s.id}
                          destinationId={d.id}
                          enabled={enabled}
                          label={`Toggle route ${s.name} -> ${d.name}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {enabledRoutes.length > 0 && (
        <section>
          <h2 className="text-sm font-medium">Enabled routes</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Attach an AI-generated transformation or NL filter to any enabled
            route. Transformations run in a QuickJS sandbox before forwarding.
          </p>
          <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            {enabledRoutes.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <div>
                  <span className="font-medium">{r.source.name}</span>
                  <span className="mx-2 text-zinc-400">→</span>
                  <span className="font-medium">{r.destination.name}</span>
                  {r.transformation && (
                    <span className="ml-3 inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      transform
                    </span>
                  )}
                  {r.filterAst && (
                    <span className="ml-2 inline-flex items-center rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                      filter
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <Link
                    href={`/routes/${r.id}/transform`}
                    className="text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    Transform →
                  </Link>
                  <Link
                    href={`/routes/${r.id}/filter`}
                    className="text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    Filter →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
