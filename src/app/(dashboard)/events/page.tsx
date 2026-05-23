import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { EventsFilter } from "@/components/events-filter";
import { DeliveryStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function formatAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

// Quick-pick time windows map to millisecond offsets from now.
const SINCE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const STATUS_VALUES = new Set<DeliveryStatus>([
  "delivered",
  "pending",
  "failed",
  "exhausted",
]);

type Search = {
  sourceId?: string;
  status?: string;
  since?: string;
  cursor?: string;
};

function buildQueryString(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;

  const { sourceId, status, since, cursor } = await searchParams;

  const sources = await prisma.source.findMany({
    where: { userId: session.user.id },
    orderBy: { name: "asc" },
  });

  // Build the where clause.
  const where: {
    source: { userId: string };
    sourceId?: string;
    receivedAt?: { gte: Date };
    deliveries?: { some: { status: DeliveryStatus } };
  } = {
    source: { userId: session.user.id },
  };
  if (sourceId) where.sourceId = sourceId;
  if (since && SINCE_MS[since]) {
    where.receivedAt = { gte: new Date(Date.now() - SINCE_MS[since]) };
  }
  if (status && STATUS_VALUES.has(status as DeliveryStatus)) {
    where.deliveries = { some: { status: status as DeliveryStatus } };
  }

  // Cursor pagination: fetch PAGE_SIZE + 1 to peek whether an older page exists.
  // Ordering (receivedAt desc, id desc) + cursor on `id` gives us a stable
  // keyset pagination even when multiple events share a receivedAt.
  const take = PAGE_SIZE + 1;
  const events = await prisma.event.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take,
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1, // skip the cursor row itself
        }
      : {}),
    include: {
      source: { select: { name: true } },
      deliveries: {
        select: { status: true },
      },
    },
  });

  const hasOlder = events.length > PAGE_SIZE;
  const visible = hasOlder ? events.slice(0, PAGE_SIZE) : events;
  const oldestId = visible.at(-1)?.id;

  // Bounded count for the header. `prisma.event.count` scans the entire
  // matching set — fine at thousands, painful at millions — so we cap at
  // 1001 with a `findMany`+`select id` and display "1000+" past the cap.
  const COUNT_CAP = 1000;
  const counted = await prisma.event.findMany({
    where,
    select: { id: true },
    take: COUNT_CAP + 1,
  });
  const totalCount = counted.length;
  const totalCountCapped = totalCount > COUNT_CAP;

  function aggregateStatus(
    deliveries: { status: DeliveryStatus }[],
  ): "delivered" | "in_flight" | "pending" | "failed" | "exhausted" | "none" {
    if (deliveries.length === 0) return "none";
    if (deliveries.some((d) => d.status === "exhausted")) return "exhausted";
    if (deliveries.some((d) => d.status === "failed")) return "failed";
    if (deliveries.some((d) => d.status === "in_flight")) return "in_flight";
    if (deliveries.some((d) => d.status === "pending")) return "pending";
    return "delivered";
  }

  const dotClass: Record<string, string> = {
    delivered: "dot dot--delivered",
    in_flight: "dot dot--in-flight",
    pending:   "dot dot--pending",
    failed:    "dot dot--failed",
    exhausted: "dot dot--exhausted",
    none:      "dot dot--none",
  };

  // Build pagination link hrefs preserving filter state.
  const filterQuery = { sourceId, status, since };
  const newestHref = `/events${buildQueryString(filterQuery)}`;
  const olderHref = oldestId
    ? `/events${buildQueryString({ ...filterQuery, cursor: oldestId })}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {totalCountCapped
              ? `${COUNT_CAP.toLocaleString()}+`
              : totalCount.toLocaleString()}{" "}
            event
            {totalCount === 1 ? "" : "s"} match
            {totalCount === 1 ? "es" : ""} your filters.
            {cursor && " Paginating older."}
          </p>
        </div>
        <EventsFilter sources={sources} />
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-3 w-8"></th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Received</th>
              <th className="px-4 py-3 text-right">Deliveries</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-16 text-center text-zinc-500"
                >
                  {cursor || sourceId || status || since
                    ? "No events match these filters."
                    : "No events yet. Send a webhook to one of your sources to get started."}
                </td>
              </tr>
            ) : (
              visible.map((e) => {
                const s = aggregateStatus(e.deliveries);
                return (
                  <tr
                    key={e.id}
                    className="border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-3">
                      <span
                        aria-label={s}
                        className={dotClass[s]}
                      />
                    </td>
                    <td className="px-4 py-3 font-medium">{e.source.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {e.method}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {formatAgo(e.receivedAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {e.deliveries.length}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/events/${e.id}`}
                        className="text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        Inspect →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <div>
          {cursor && (
            <Link
              href={newestHref}
              className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              ← Jump to newest
            </Link>
          )}
        </div>
        <div>
          {hasOlder && olderHref && (
            <Link
              href={olderHref}
              className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Older →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
