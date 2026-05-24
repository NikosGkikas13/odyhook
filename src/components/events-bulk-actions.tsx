"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { DeliveryStatus } from "@/generated/prisma/enums";

type AggStatus =
  | "delivered"
  | "in_flight"
  | "pending"
  | "failed"
  | "exhausted"
  | "none";

const DOT_CLASS: Record<AggStatus, string> = {
  delivered: "dot dot--delivered",
  in_flight: "dot dot--in-flight",
  pending: "dot dot--pending",
  failed: "dot dot--failed",
  exhausted: "dot dot--exhausted",
  none: "dot dot--none",
};

function aggregateStatus(d: { status: DeliveryStatus }[]): AggStatus {
  if (d.length === 0) return "none";
  if (d.some((x) => x.status === "exhausted")) return "exhausted";
  if (d.some((x) => x.status === "failed")) return "failed";
  if (d.some((x) => x.status === "in_flight")) return "in_flight";
  if (d.some((x) => x.status === "pending")) return "pending";
  return "delivered";
}

function formatAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export type BulkEventRow = {
  id: string;
  method: string;
  receivedAt: Date;
  source: { name: string };
  deliveries: { status: DeliveryStatus }[];
};

export function EventsBulkActions({ events }: { events: BulkEventRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "replay" | "cancel">(null);
  const [toast, setToast] = useState<string | null>(null);

  const allSelected = events.length > 0 && selected.size === events.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(events.map((e) => e.id)));
    }
  }

  async function runReplay() {
    setBusy("replay");
    setToast(null);
    try {
      const res = await fetch("/api/events/bulk-replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (res.status === 429) {
        const retry = res.headers.get("retry-after") ?? "?";
        setToast(`Rate limited. Try again in ${retry}s.`);
        return;
      }
      if (!res.ok) {
        setToast("Bulk replay failed.");
        return;
      }
      const data = (await res.json()) as {
        eventsReplayed: number;
        deliveriesCreated: number;
        skipped: number;
      };
      const skipNote =
        data.skipped > 0 ? ` (${data.skipped} skipped)` : "";
      setToast(
        `Replayed ${data.eventsReplayed} event${data.eventsReplayed === 1 ? "" : "s"} → ${data.deliveriesCreated} deliveries${skipNote}`,
      );
      setSelected(new Set());
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  async function runCancel() {
    const n = selected.size;
    const confirmed = window.confirm(
      `Cancel all non-terminal deliveries on ${n} event${n === 1 ? "" : "s"}? They'll be marked exhausted with "cancelled by user". You can still replay them later.`,
    );
    if (!confirmed) return;
    setBusy("cancel");
    setToast(null);
    try {
      const res = await fetch("/api/events/bulk-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        setToast("Bulk cancel failed.");
        return;
      }
      const data = (await res.json()) as { cancelled: number };
      setToast(
        `Cancelled ${data.cancelled} deliver${data.cancelled === 1 ? "y" : "ies"}.`,
      );
      setSelected(new Set());
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  const busyAny = busy !== null || isPending;
  const nothingSelected = selected.size === 0;
  const actionsDisabled = busyAny || nothingSelected;

  return (
    <>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border border-zinc-200 bg-white/90 px-4 py-2 text-sm shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
        <span className={`font-medium ${nothingSelected ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
          {selected.size} selected
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={runReplay}
          disabled={actionsDisabled}
          className="btn-primary-ody inline-flex h-8 items-center rounded-md px-3 text-xs font-medium disabled:opacity-60"
        >
          {busy === "replay" ? "Replaying…" : "Replay"}
        </button>
        <button
          type="button"
          onClick={runCancel}
          disabled={actionsDisabled}
          className="inline-flex h-8 items-center rounded-md border border-red-200 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950"
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </button>
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          disabled={actionsDisabled}
          className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-60 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Clear
        </button>
      </div>

      {toast && (
        <div
          role="status"
          className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {toast}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800">
            <tr>
              <th className="px-4 py-3 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all visible events"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  disabled={events.length === 0 || busyAny}
                />
              </th>
              <th className="px-4 py-3 w-8"></th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Received</th>
              <th className="px-4 py-3 text-right">Deliveries</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-zinc-500">
                  No events match these filters.
                </td>
              </tr>
            ) : (
              events.map((e) => {
                const agg = aggregateStatus(e.deliveries);
                const isSel = selected.has(e.id);
                return (
                  <tr
                    key={e.id}
                    className={`border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/40 ${isSel ? "bg-zinc-50/70 dark:bg-zinc-800/60" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select event ${e.id}`}
                        checked={isSel}
                        onChange={() => toggleOne(e.id)}
                        disabled={busyAny}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span aria-label={agg} className={DOT_CLASS[agg]} />
                    </td>
                    <td className="px-4 py-3 font-medium">{e.source.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {e.method}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {formatAgo(e.receivedAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {e.deliveries.length}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/events/${e.id}`}
                        className="text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        Inspect →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
