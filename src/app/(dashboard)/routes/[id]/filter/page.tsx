import { notFound } from "next/navigation";
import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { FilterEditor } from "@/components/filter-editor";

export const dynamic = "force-dynamic";

export default async function RouteFilterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;

  const { id } = await params;

  const route = await prisma.route.findFirst({
    where: { id, source: { userId: session.user.id } },
    include: {
      source: true,
      destination: true,
    },
  });

  if (!route) notFound();

  const hasApiKey = !!(await prisma.providerKey.findFirst({
    where: { userId: session.user.id },
    select: { provider: true },
  }));

  const initialAstJson = route.filterAst
    ? JSON.stringify(route.filterAst, null, 2)
    : "";

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/routes"
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to routes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Filter</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <span className="font-medium">{route.source.name}</span> →{" "}
          <span className="font-medium">{route.destination.name}</span>.
          Describe the rule in plain English — Claude compiles it to a
          deterministic AST that runs on every event with no per-event LLM
          cost.
        </p>
      </div>

      {!hasApiKey && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          You don&apos;t have an Anthropic API key configured. Add one in{" "}
          <Link href="/settings/api-keys" className="font-medium underline">
            Settings → API Keys
          </Link>{" "}
          to compile rules. You can still hand-edit the JSON AST below.
        </div>
      )}

      <FilterEditor
        routeId={route.id}
        initialPrompt={route.filterPrompt ?? ""}
        initialAstJson={initialAstJson}
        hasApiKey={hasApiKey}
        hasExistingFilter={!!route.filterAst}
      />
    </div>
  );
}
