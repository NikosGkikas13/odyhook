"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ThroughputRow } from "@/lib/metrics/queries";

import { formatTimestamp } from "./format";

export function ThroughputChart({ data }: { data: ThroughputRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No events in this window.
      </div>
    );
  }
  const chartData = data.map((r) => ({
    t: r.bucket.getTime(),
    count: r.count,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-line)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-line)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          scale="time"
          tickFormatter={formatTimestamp}
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
        />
        <YAxis
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
          allowDecimals={false}
        />
        <Tooltip
          labelFormatter={(v) => formatTimestamp(v as number)}
          contentStyle={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-1)",
            fontSize: 12,
          }}
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="var(--chart-line)"
          fill="url(#throughputFill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
