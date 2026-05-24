"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Select, type SelectOption } from "@/components/ui/select";

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

// Radix Select forbids "" as an Item value (it's reserved for the "unset"
// state). Use a sentinel for the "no filter" option and translate back to ""
// for the URL params.
const ALL = "__all__";

const STATUSES: SelectOption[] = [
  { value: ALL, label: "Any status" },
  { value: "delivered", label: "Delivered" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "exhausted", label: "Exhausted" },
];

const WINDOWS: SelectOption[] = [
  { value: ALL, label: "All time" },
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

  const sourceId = params.get("sourceId") || ALL;
  const status = params.get("status") || ALL;
  const since = params.get("since") || ALL;

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== ALL) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current cursor — reset to first page.
    next.delete("cursor");
    router.push(`/events?${next.toString()}`);
  }

  const sourceOptions: SelectOption[] = [
    { value: ALL, label: "All sources" },
    ...sources.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        ariaLabel="Filter by source"
        value={sourceId}
        onValueChange={(v) => updateParam("sourceId", v)}
        options={sourceOptions}
      />
      <Select
        ariaLabel="Filter by delivery status"
        value={status}
        onValueChange={(v) => updateParam("status", v)}
        options={STATUSES}
      />
      <Select
        ariaLabel="Filter by time window"
        value={since}
        onValueChange={(v) => updateParam("since", v)}
        options={WINDOWS}
      />
    </div>
  );
}
