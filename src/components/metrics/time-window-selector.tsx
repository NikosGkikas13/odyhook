import Link from "next/link";

import { DEFAULT_SINCE, type SinceWindow } from "@/lib/metrics/types";

const WINDOWS: { value: SinceWindow; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export function TimeWindowSelector({
  basePath,
  active,
  extraParams = {},
}: {
  basePath: string;
  active: SinceWindow;
  extraParams?: Record<string, string>;
}) {
  return (
    <nav
      aria-label="Time window"
      className="inline-flex gap-1 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
    >
      {WINDOWS.map((w) => {
        const isActive = w.value === active;
        const params = new URLSearchParams(extraParams);
        if (w.value !== DEFAULT_SINCE) params.set("since", w.value);
        const href = params.toString() ? `${basePath}?${params}` : basePath;
        return (
          <Link
            key={w.value}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "rounded px-3 py-1 text-xs font-medium text-zinc-900 dark:text-zinc-100"
                : "rounded px-3 py-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }
            style={
              isActive
                ? { borderBottom: "2px solid var(--brand-blue-fg)" }
                : undefined
            }
          >
            {w.label}
          </Link>
        );
      })}
    </nav>
  );
}
