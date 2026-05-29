"use client";

import { revokeApiToken } from "@/lib/actions/api-tokens";

export function RevokeButton({ id }: { id: string }) {
  return (
    <form action={revokeApiToken}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="h-8 shrink-0 rounded-md border border-red-200 px-3 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
      >
        Revoke
      </button>
    </form>
  );
}
