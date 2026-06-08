import { notFound } from "next/navigation";
import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canonicalPair, type DiffChange } from "@/lib/ai/event-diff";
import { ExplainDiffButton } from "@/components/explain-diff-button";

export const dynamic = "force-dynamic";

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default async function CompareEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;

  const { a, b } = await searchParams;
  if (!a || !b || a === b) notFound();

  const events = await prisma.event.findMany({
    where: { id: { in: [a, b] }, source: { userId: session.user.id } },
    include: { source: { select: { name: true } } },
  });
  if (events.length !== 2) notFound();

  const [e0, e1] = events;
  const { olderId, newerId } = canonicalPair(e0, e1);
  const older = e0.id === olderId ? e0 : e1;
  const newer = e0.id === newerId ? e0 : e1;

  const hasApiKey = !!(await prisma.providerKey.findFirst({
    where: { userId: session.user.id },
    select: { provider: true },
  }));

  const cached = await prisma.aiEventDiff.findUnique({
    where: { eventAId_eventBId: { eventAId: olderId, eventBId: newerId } },
  });
  const initialResult = cached
    ? {
        summary: cached.summary,
        changes: cached.changes as unknown as DiffChange[],
      }
    : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/events"
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to events
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Compare events
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Older → newer, by received time.
        </p>
      </div>

      <ExplainDiffButton
        aId={olderId}
        bId={newerId}
        hasApiKey={hasApiKey}
        initialResult={initialResult}
      />

      <section className="grid gap-6 lg:grid-cols-2">
        {[older, newer].map((ev, idx) => (
          <div
            key={ev.id}
            className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
              {idx === 0 ? "A · older" : "B · newer"} · {ev.source.name}
            </div>
            <p className="break-all px-4 pt-2 font-mono text-xs text-zinc-500">
              {ev.id} · {ev.receivedAt.toISOString()}
            </p>
            <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-xs">
              {prettyJson(ev.bodyRaw)}
            </pre>
          </div>
        ))}
      </section>
    </div>
  );
}
