"use client";

import { useRouter, useSearchParams } from "next/navigation";

// Filter bar for the Events page: source, delivery status, time window.
// Any change resets the `cursor` param (otherwise the cursor would point at
// an event outside the new result set and pagination would silently break).

export type StatusFilter =
  | ""
  | "delivered"
  | "pending"
  | "failed"
  | "exhausted";

export type SinceFilter = "" | "1h" | "24h" | "7d" | "30d";

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "delivered", label: "Delivered" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "exhausted", label: "Exhausted" },
];

const WINDOWS: { value: SinceFilter; label: string }[] = [
  { value: "", label: "All time" },
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];

export function EventsFilter({
  sources,
}: {
  sources: { id: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const sourceId = params.get("sourceId") ?? "";
  const status = (params.get("status") as StatusFilter) ?? "";
  const since = (params.get("since") as SinceFilter) ?? "";

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current cursor — reset to first page.
    next.delete("cursor");
    router.push(`/events?${next.toString()}`);
  }

  const selectClass =
    "h-9 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-sm sm:flex-none sm:px-3 dark:border-zinc-800 dark:bg-zinc-900";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Filter by source"
        value={sourceId}
        onChange={(e) => updateParam("sourceId", e.target.value)}
        className={selectClass}
      >
        <option value="">All sources</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by delivery status"
        value={status}
        onChange={(e) => updateParam("status", e.target.value)}
        className={selectClass}
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by time window"
        value={since}
        onChange={(e) => updateParam("since", e.target.value)}
        className={selectClass}
      >
        {WINDOWS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>
    </div>
  );
}
