"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      className="rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-600 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      disabled={pending}
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
