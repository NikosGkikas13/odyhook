import { notFound } from "next/navigation";
import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ReplayButton } from "@/components/replay-button";
import { DiagnoseButton } from "@/components/diagnose-button";

export const dynamic = "force-dynamic";

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

const statusBadge: Record<string, string> = {
  pending:   "pill pill--pending",
  in_flight: "pill pill--in-flight",
  delivered: "pill pill--delivered",
  failed:    "pill pill--failed",
  exhausted: "pill pill--exhausted",
};

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;

  const { id } = await params;

  const event = await prisma.event.findFirst({
    where: { id, source: { userId: session.user.id } },
    include: {
      source: true,
      deliveries: {
        orderBy: { createdAt: "asc" },
        include: {
          destination: { select: { name: true, url: true } },
          diagnosis: true,
        },
      },
    },
  });

  if (!event) notFound();

  const hasApiKey = !!(await prisma.providerKey.findFirst({
    where: { userId: session.user.id },
    select: { provider: true },
  }));

  const headers = event.headersJson as Record<string, string>;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/events"
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to events
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {event.source.name}
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-zinc-500">
              {event.id} · {event.method} · {event.receivedAt.toISOString()}
            </p>
          </div>
          <ReplayButton eventId={event.id} />
        </div>
      </div>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
            Headers
          </div>
          <div className="max-h-96 overflow-auto p-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-xs">
              {Object.entries(headers).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd className="break-all text-zinc-900 dark:text-zinc-100">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
            Payload
          </div>
          <pre className="max-h-96 overflow-auto p-4 font-mono text-xs">
            {prettyJson(event.bodyRaw)}
          </pre>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
          Deliveries
        </div>
        {event.deliveries.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            No deliveries — this event was ingested but no routes were enabled.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {event.deliveries.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 p-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={statusBadge[d.status] ?? "pill"}>
                      {d.status}
                    </span>
                    <span className="text-sm font-medium">
                      {d.destination.name}
                    </span>
                  </div>
                  <code className="mt-1 block break-all font-mono text-xs text-zinc-500">
                    {d.destination.url}
                  </code>
                  {d.lastError && (
                    <p className="mt-2 font-mono text-xs text-red-600">
                      {d.lastError}
                    </p>
                  )}
                  {d.responseBodySnippet && (
                    <pre className="mt-2 max-h-32 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {d.responseBodySnippet}
                    </pre>
                  )}
                  {(d.status === "failed" || d.status === "exhausted") && (
                    <DiagnoseButton
                      deliveryId={d.id}
                      hasApiKey={hasApiKey}
                      initialSummary={d.diagnosis?.summary ?? null}
                      initialDetail={d.diagnosis?.detail ?? null}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 text-xs text-zinc-500">
                  <span>attempt {d.attemptCount}</span>
                  {d.responseCode && <span>HTTP {d.responseCode}</span>}
                  {d.deliveredAt && <span>{formatDate(d.deliveredAt)}</span>}
                  {d.nextRetryAt && <span>retry at {formatDate(d.nextRetryAt)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
