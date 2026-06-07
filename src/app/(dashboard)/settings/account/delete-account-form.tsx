"use client";

import { useState } from "react";

import { deleteAccount } from "@/lib/actions/account";

// Destructive, irreversible. We gate the button behind an exact email re-type
// (also re-checked server-side) so deletion can't happen on a stray click.
export function DeleteAccountForm({ email }: { email: string }) {
  const [confirm, setConfirm] = useState("");
  const matches = confirm.trim().toLowerCase() === email.toLowerCase();

  return (
    <form action={deleteAccount} className="mt-4 space-y-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">
          Type <strong>{email}</strong> to confirm
        </span>
        <input
          name="confirmEmail"
          autoComplete="off"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={email}
          className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <button
        type="submit"
        disabled={!matches}
        className="inline-flex h-9 items-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Permanently delete my account
      </button>
    </form>
  );
}
