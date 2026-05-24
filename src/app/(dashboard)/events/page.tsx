import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { EventsBulkActions } from "@/components/events-bulk-actions";
import { EventsFilter } from "@/components/events-filter";
import { DeliveryStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

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

  const take = PAGE_SIZE + 1;
  const events = await prisma.event.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take,
    ...(cursor
      ? { cursor: { id: cursor }, skip: 1 }
      : {}),
    include: {
      source: { select: { name: true } },
      deliveries: { select: { status: true } },
    },
  });

  const hasOlder = events.length > PAGE_SIZE;
  const visible = hasOlder ? events.slice(0, PAGE_SIZE) : events;
  const oldestId = visible.at(-1)?.id;

  const COUNT_CAP = 1000;
  const counted = await prisma.event.findMany({
    where,
    select: { id: true },
    take: COUNT_CAP + 1,
  });
  const totalCount = counted.length;
  const totalCountCapped = totalCount > COUNT_CAP;

  const filterQuery = { sourceId, status, since };
  const newestHref = `/events${buildQueryString(filterQuery)}`;
  const olderHref = oldestId
    ? `/events${buildQueryString({ ...filterQuery, cursor: oldestId })}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {totalCountCapped
              ? `${COUNT_CAP.toLocaleString()}+`
              : totalCount.toLocaleString()}{" "}
            event{totalCount === 1 ? "" : "s"} match
            {totalCount === 1 ? "es" : ""} your filters.
            {cursor && " Paginating older."}
          </p>
        </div>
        <EventsFilter sources={sources} />
      </div>

      <EventsBulkActions events={visible} />

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

