import Link from "next/link";

import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 sm:px-6 sm:py-24">
      <div className="max-w-2xl text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          Odyhook
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
          Webhooks that don&apos;t silently fail.
        </h1>
        <p className="mt-6 text-base leading-7 text-zinc-600 sm:text-lg dark:text-zinc-400">
          Ingest every event. Log it forever. Forward it anywhere. Retry on
          failure. Replay with one click.
        </p>
        <div className="mt-10 flex items-center justify-center">
          <Link
            href={session?.user ? "/sources" : "/signin"}
            className="btn-primary-ody inline-flex h-11 items-center rounded-md px-5 text-sm font-medium shadow-sm"
          >
            {session?.user ? "Open dashboard" : "Sign in"}
          </Link>
        </div>
      </div>
    </main>
  );
}
