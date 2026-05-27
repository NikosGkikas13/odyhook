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

import type { SuccessRateRow } from "@/lib/metrics/queries";

import { formatTimestamp } from "./format";

export function SuccessRateChart({ data }: { data: SuccessRateRow[] }) {
  const hasTerminal = data.some((r) => r.delivered + r.failed > 0);
  if (!hasTerminal) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No completed deliveries in this window.
      </div>
    );
  }
  const chartData = data.map((r) => {
    const total = r.delivered + r.failed;
    return {
      t: r.bucket.getTime(),
      pct: total === 0 ? null : (r.delivered / total) * 100,
      delivered: r.delivered,
      failed: r.failed,
    };
  });
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
          domain={[0, 100]}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          labelFormatter={(v) => formatTimestamp(v as number)}
          formatter={(value, name) => {
            if (name === "pct") {
              return [value === null ? "—" : `${Number(value).toFixed(1)}%`, "Success rate"];
            }
            return [value, name];
          }}
          contentStyle={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-1)",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="pct"
          stroke="var(--chart-line)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
