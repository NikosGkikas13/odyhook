import Link from "next/link";

import type { TopFailingRow } from "@/lib/metrics/queries";

function relativeTime(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function TopFailingTable({ rows }: { rows: TopFailingRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No failures in this window.
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
          <th className="pb-2 font-medium">Destination</th>
          <th className="pb-2 text-right font-medium">Failures</th>
          <th className="pb-2 text-right font-medium">Last failure</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.destinationId} className="border-t border-zinc-100 dark:border-zinc-800">
            <td className="py-2">
              <Link
                href={`/destinations/${r.destinationId}`}
                className="text-zinc-900 hover:underline dark:text-zinc-100"
              >
                {r.name}
              </Link>
            </td>
            <td className="py-2 text-right tabular-nums">{r.failures}</td>
            <td className="py-2 text-right text-zinc-500 tabular-nums">{relativeTime(r.lastFailure)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
