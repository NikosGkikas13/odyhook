"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { LatencyRow } from "@/lib/metrics/queries";

import { formatTimestamp } from "./format";

export function LatencyChart({ data }: { data: LatencyRow[] }) {
  const hasData = data.some((r) => r.p50 !== null);
  if (!hasData) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No delivered events in this window.
      </div>
    );
  }
  const chartData = data.map((r) => ({
    t: r.bucket.getTime(),
    p50: r.p50,
    p95: r.p95,
  }));
  const allValues = chartData
    .flatMap((r) => [r.p50, r.p95])
    .filter((v): v is number => v !== null);
  const max = allValues.length ? Math.max(...allValues) : 0;
  const min = allValues.length ? Math.min(...allValues.filter((v) => v > 0)) : 1;
  const useLog = max > min * 10;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
          scale={useLog ? "log" : "linear"}
          domain={useLog ? [1, "dataMax"] : [0, "dataMax"]}
          allowDataOverflow
          tickFormatter={(v) => (Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(1)}s` : `${v}ms`)}
        />
        <Tooltip
          labelFormatter={(v) => formatTimestamp(v as number)}
          formatter={(value, name) => {
            if (value === null) return ["—", name];
            const ms = Number(value);
            const display = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
            return [display, name];
          }}
          contentStyle={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-1)",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="p50"
          stroke="var(--chart-line)"
          strokeWidth={2}
          dot={false}
          name="p50"
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="p95"
          stroke="var(--chart-line)"
          strokeDasharray="4 3"
          strokeWidth={2}
          dot={false}
          name="p95"
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
