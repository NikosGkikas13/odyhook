"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function DestinationDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-900">
      <h2 className="text-sm font-medium">Couldn't load this destination</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Something went wrong. The error has been reported.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        Try again
      </button>
    </div>
  );
}
