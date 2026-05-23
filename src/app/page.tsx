import Link from "next/link";

import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24">
      <div className="max-w-2xl text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          Odyhook
        </p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight">
          Webhooks that don&apos;t silently fail.
        </h1>
        <p className="mt-6 text-lg leading-7 text-zinc-600 dark:text-zinc-400">
          Ingest every event. Log it forever. Forward it anywhere. Retry on
          failure. Replay with one click.
        </p>
        <div className="mt-10 flex items-center justify-center">
          <Link
            href={session?.user ? "/sources" : "/signin"}
            className="inline-flex h-11 items-center rounded-md bg-zinc-900 px-5 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {session?.user ? "Open dashboard" : "Sign in"}
          </Link>
        </div>
      </div>
    </main>
  );
}
