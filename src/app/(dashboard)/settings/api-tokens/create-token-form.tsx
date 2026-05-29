"use client";

import { useState } from "react";
import { createApiToken } from "@/lib/actions/api-tokens";

export function CreateTokenForm() {
  const [token, setToken] = useState<string | null>(null);

  async function action(formData: FormData) {
    const res = await createApiToken(formData);
    setToken(res.token);
  }

  return (
    <div className="space-y-3">
      <form action={action} className="flex gap-2">
        <input
          name="name"
          required
          maxLength={60}
          placeholder="e.g. my-laptop, ci-pipeline"
          className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
        >
          Create token
        </button>
      </form>
      {token && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-900/20">
          <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
            Copy this token now — you won&apos;t be able to see it again.
          </p>
          <code className="block break-all rounded border border-zinc-200 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900">
            {token}
          </code>
        </div>
      )}
    </div>
  );
}
