import Link from "next/link";
import { notFound } from "next/navigation";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  getLatency,
  getSuccessRate,
  getThroughput,
  getTopFailing,
} from "@/lib/metrics/queries";
import { DEFAULT_SINCE, SINCE_VALUES, type SinceWindow } from "@/lib/metrics/types";

import { ChartCard } from "@/components/metrics/chart-card";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { RefreshButton } from "@/components/metrics/refresh-button";
import { SuccessRateChart } from "@/components/metrics/success-rate-chart";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { TimeWindowSelector } from "@/components/metrics/time-window-selector";
import { TopFailingTable } from "@/components/metrics/top-failing-table";
import { updateSourceRetention } from "@/lib/actions/sources";
import { MAX_RETENTION_DAYS } from "@/lib/services/sources";

export const revalidate = 60;

function parseSince(value: string | undefined): SinceWindow {
  if (value && SINCE_VALUES.has(value as SinceWindow)) return value as SinceWindow;
  return DEFAULT_SINCE;
}

export default async function SourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ since?: string }>;
}) {
  const { id } = await params;
  const { since: rawSince } = await searchParams;
  const since = parseSince(rawSince);
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;

  const source = await prisma.source.findFirst({
    where: { id, userId },
    select: { id: true, name: true, slug: true, retentionDays: true },
  });
  if (!source) notFound();

  const [throughput, successRate, latency, topFailing] = await Promise.all([
    getThroughput({ userId, since, sourceId: source.id }),
    getSuccessRate({ userId, since, sourceId: source.id }),
    getLatency({ userId, since, sourceId: source.id }),
    getTopFailing({ userId, since, sourceId: source.id }),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <Link href="/sources" className="text-sm text-zinc-500 hover:underline">
          ← Sources
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{source.name}</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">/api/ingest/{source.slug}</p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <TimeWindowSelector basePath={`/sources/${source.id}`} active={since} />
        <RefreshButton />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Throughput" subtitle="Events received over time">
          <ThroughputChart data={throughput} />
        </ChartCard>
        <ChartCard title="Success rate" subtitle="Delivered ÷ (delivered + failed)">
          <SuccessRateChart data={successRate} />
        </ChartCard>
        <ChartCard title="Delivery latency" subtitle="p50 (solid) / p95 (dashed)">
          <LatencyChart data={latency} />
        </ChartCard>
        <ChartCard title="Top failing destinations" subtitle="For this source">
          <TopFailingTable rows={topFailing} />
        </ChartCard>
      </div>

      <section className="max-w-xl rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Data retention</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {source.retentionDays == null
            ? "Events on this source are kept indefinitely."
            : `Events on this source are deleted after ${source.retentionDays} day${source.retentionDays === 1 ? "" : "s"}.`}{" "}
          A daily job purges anything older than the window.
        </p>
        <form action={updateSourceRetention} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={source.id} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Retention (days, 1&ndash;{MAX_RETENTION_DAYS}; blank = indefinite)
            </span>
            <input
              name="retentionDays"
              type="number"
              min={1}
              max={MAX_RETENTION_DAYS}
              defaultValue={source.retentionDays ?? ""}
              placeholder="indefinite"
              className="h-9 w-40 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="submit"
            className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Save
          </button>
        </form>
      </section>
    </div>
  );
}
