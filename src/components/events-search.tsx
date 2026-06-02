"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { previewSearch } from "@/lib/actions/search";
import { encodeEventQuery } from "@/lib/search/url";
import type { EventQuery } from "@/lib/search/types";

export function EventsSearch({ initialText = "" }: { initialText?: string }) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const [pending, startTransition] = useTransition();
  const [compiling, setCompiling] = useState(false);
  const [preview, setPreview] = useState<{ query: EventQuery; summary: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCompile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPreview(null);
    setCompiling(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const res = await previewSearch(text, tz);
      if (res.ok) setPreview({ query: res.query, summary: res.summary });
      else setError(res.error);
    } finally {
      setCompiling(false);
    }
  }

  function onRun() {
    if (!preview) return;
    const sp = new URLSearchParams();
    sp.set("q", encodeEventQuery(preview.query));
    if (text.trim()) sp.set("qtext", text.trim());
    startTransition(() => router.push(`/events?${sp.toString()}`));
  }

  return (
    <div className="space-y-2">
      <form onSubmit={onCompile} className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          placeholder='Search in English, e.g. "failed stripe events yesterday from gmail users"'
          aria-label="Search events in natural language"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={compiling || !text.trim()}
          className="btn-primary-ody inline-flex h-9 items-center rounded-md px-3 text-sm font-medium disabled:opacity-60"
        >
          {compiling ? "Compiling…" : "Compile"}
        </button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {preview && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm dark:border-indigo-900 dark:bg-indigo-950">
          <span className="text-zinc-600 dark:text-zinc-300">Interpreted as:</span>
          {preview.summary.map((chip, i) => (
            <span key={i} className="rounded bg-white px-2 py-0.5 text-xs font-medium text-indigo-900 dark:bg-zinc-900 dark:text-indigo-100">
              {chip}
            </span>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="btn-primary-ody inline-flex h-8 items-center rounded-md px-3 text-xs font-medium disabled:opacity-60"
          >
            {pending ? "Running…" : "Run search"}
          </button>
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}
