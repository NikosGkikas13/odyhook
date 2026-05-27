import { auth } from "@/auth";
import {
  getLatency,
  getOverviewTotals,
  getSuccessRate,
  getThroughput,
  getTopFailing,
} from "@/lib/metrics/queries";
import { DEFAULT_SINCE, SINCE_VALUES, type SinceWindow } from "@/lib/metrics/types";

import { ChartCard } from "@/components/metrics/chart-card";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { RefreshButton } from "@/components/metrics/refresh-button";
import { StatCard } from "@/components/metrics/stat-card";
import { SuccessRateChart } from "@/components/metrics/success-rate-chart";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { TimeWindowSelector } from "@/components/metrics/time-window-selector";
import { TopFailingTable } from "@/components/metrics/top-failing-table";

export const revalidate = 60;

function parseSince(value: string | undefined): SinceWindow {
  if (value && SINCE_VALUES.has(value as SinceWindow)) return value as SinceWindow;
  return DEFAULT_SINCE;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1)}%`;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { since: rawSince } = await searchParams;
  const since = parseSince(rawSince);
  const userId = session.user.id;

  const [totals, throughput, successRate, latency, topFailing] = await Promise.all([
    getOverviewTotals({ userId, since }),
    getThroughput({ userId, since }),
    getSuccessRate({ userId, since }),
    getLatency({ userId, since }),
    getTopFailing({ userId, since }),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Account-wide activity for the selected window.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TimeWindowSelector basePath="/overview" active={since} />
          <RefreshButton />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total events" value={totals.totalEvents.toLocaleString()} />
        <StatCard label="Success rate" value={fmtPct(totals.successRate)} />
        <StatCard label="p95 latency" value={fmtMs(totals.p95LatencyMs)} />
        <StatCard label="Active sources" value={totals.activeSources.toLocaleString()} />
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
        <ChartCard title="Top failing destinations" subtitle="Highest failure counts in window">
          <TopFailingTable rows={topFailing} />
        </ChartCard>
      </div>
    </div>
  );
}
