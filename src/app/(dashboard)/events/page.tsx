import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { EventsBulkActions } from "@/components/events-bulk-actions";
import { EventsFilter } from "@/components/events-filter";
import { EventsSearch } from "@/components/events-search";
import { buildEventWhere } from "@/lib/search/where";
import { runEventSearch } from "@/lib/search/run";
import { describeEventQuery } from "@/lib/search/describe";
import { decodeEventQuery } from "@/lib/search/url";
import { DeliveryStatus } from "@/generated/prisma/enums";
import type { DeliveryStatusValue } from "@/lib/search/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

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
  q?: string;
  qtext?: string;
};

function sinceIso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

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
  const userId = session.user.id;

  const { sourceId, status, since, cursor, q, qtext } = await searchParams;

  const sources = await prisma.source.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });

  // ---- Search mode (?q=) -------------------------------------------------
  if (q) {
    let decoded;
    try {
      decoded = decodeEventQuery(q);
    } catch {
      return (
        <div className="space-y-6">
          <Header title="Events" subtitle="Couldn't read that search query." />
          <EventsSearch initialText={qtext ?? ""} />
          <Link href="/events" className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            ← Clear search
          </Link>
        </div>
      );
    }

    const result = await runEventSearch(userId, decoded, { limit: PAGE_SIZE, cursor });
    const chips = describeEventQuery(decoded, sources);
    const olderHref = result.nextCursor
      ? `/events${buildQueryString({ q, qtext, cursor: result.nextCursor })}`
      : null;

    return (
      <div className="space-y-6">
        <Header
          title="Events"
          subtitle={
            result.scanCapped
              ? `Searched the most recent ${result.scanned.toLocaleString()} events — narrow by source or time to reach older ones.`
              : `${result.events.length} match${result.events.length === 1 ? "" : "es"} on this page.`
          }
        />
        <EventsSearch initialText={qtext ?? ""} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Interpreted as:</span>
          {chips.map((c, i) => (
            <span key={i} className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium dark:bg-zinc-800">{c}</span>
          ))}
          <Link href="/events" className="ml-2 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            Clear search
          </Link>
        </div>

        <EventsBulkActions events={result.events} />

        <div className="flex items-center justify-end text-sm">
          {olderHref && (
            <Link href={olderHref} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              Older →
            </Link>
          )}
        </div>
      </div>
    );
  }

  // ---- Normal filter-bar mode -------------------------------------------
  const statusValue: DeliveryStatusValue | null =
    status && STATUS_VALUES.has(status as DeliveryStatus)
      ? (status as DeliveryStatusValue)
      : null;

  const where = buildEventWhere(userId, {
    sourceId: sourceId ?? null,
    receivedAfter: since && SINCE_MS[since] ? sinceIso(SINCE_MS[since]) : null,
    receivedBefore: null,
    status: statusValue ? [statusValue] : null,
  });

  const take = PAGE_SIZE + 1;
  const events = await prisma.event.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      source: { select: { name: true } },
      deliveries: { select: { status: true } },
    },
  });

  const hasOlder = events.length > PAGE_SIZE;
  const visible = hasOlder ? events.slice(0, PAGE_SIZE) : events;
  const oldestId = visible.at(-1)?.id;

  const COUNT_CAP = 1000;
  const counted = await prisma.event.findMany({ where, select: { id: true }, take: COUNT_CAP + 1 });
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
        <Header
          title="Events"
          subtitle={`${totalCountCapped ? `${COUNT_CAP.toLocaleString()}+` : totalCount.toLocaleString()} event${totalCount === 1 ? "" : "s"} match${totalCount === 1 ? "es" : ""} your filters.${cursor ? " Paginating older." : ""}`}
        />
        <EventsFilter sources={sources} />
      </div>

      <EventsSearch />

      <EventsBulkActions events={visible} />

      <div className="flex items-center justify-between text-sm">
        <div>
          {cursor && (
            <Link href={newestHref} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              ← Jump to newest
            </Link>
          )}
        </div>
        <div>
          {hasOlder && olderHref && (
            <Link href={olderHref} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              Older →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
    </div>
  );
}
