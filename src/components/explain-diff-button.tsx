"use client";

import { useState, useTransition } from "react";

import {
  explainEventDiffAction,
  type EventDiffView,
} from "@/lib/actions/event-diff";

type Props = {
  aId: string;
  bId: string;
  hasApiKey: boolean;
  initialResult?: EventDiffView | null;
};

const KIND_LABEL: Record<string, string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
};

const KIND_CLASS: Record<string, string> = {
  added: "text-emerald-700 dark:text-emerald-300",
  removed: "text-red-700 dark:text-red-300",
  changed: "text-amber-700 dark:text-amber-300",
};

export function ExplainDiffButton({
  aId,
  bId,
  hasApiKey,
  initialResult,
}: Props) {
  const [result, setResult] = useState<EventDiffView | null>(
    initialResult ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await explainEventDiffAction(aId, bId);
        setResult(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (result) {
    return (
      <div className="rounded-md border border-indigo-300 bg-indigo-50 p-4 text-sm dark:border-indigo-900 dark:bg-indigo-950">
        <div className="font-medium text-indigo-900 dark:text-indigo-100">
          What changed (Claude)
        </div>
        <p className="mt-1 text-indigo-900 dark:text-indigo-100">
          {result.summary}
        </p>
        {result.changes.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-xs">
            {result.changes.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2">
                <span className="text-indigo-900 dark:text-indigo-100">
                  {c.path}
                </span>
                <span className={KIND_CLASS[c.kind]}>
                  {KIND_LABEL[c.kind]}
                </span>
                {c.kind === "changed" && (
                  <span className="text-indigo-700 dark:text-indigo-300">
                    {c.from} → {c.to}
                  </span>
                )}
                {c.kind === "added" && (
                  <span className="text-indigo-700 dark:text-indigo-300">
                    {c.to}
                  </span>
                )}
                {c.kind === "removed" && (
                  <span className="text-indigo-700 dark:text-indigo-300">
                    {c.from}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={!hasApiKey || isPending}
        className="inline-flex h-8 items-center rounded-md border border-indigo-300 bg-indigo-50 px-3 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-60 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
        title={
          hasApiKey
            ? "Ask Claude to explain what changed"
            : "Add a Claude API key in Settings to enable"
        }
      >
        {isPending ? "Explaining…" : "Explain with Claude"}
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
