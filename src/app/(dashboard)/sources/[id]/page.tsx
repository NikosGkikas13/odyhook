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
    select: { id: true, name: true, slug: true },
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
    </div>
  );
}
