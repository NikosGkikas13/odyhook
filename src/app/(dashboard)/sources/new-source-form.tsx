"use client";

import { useActionState, useState } from "react";

import { createSource } from "@/lib/actions/sources";
import type { FormState } from "@/lib/actions/form-error";

const initialState: FormState = {};

export function NewSourceForm() {
  const [state, formAction, pending] = useActionState(createSource, initialState);
  // Drives the signing-secret field's `required` attribute: every verified
  // style needs a secret (Stripe/GitHub/generic-sha256 all HMAC the body).
  const [verifyStyle, setVerifyStyle] = useState("none");
  const secretRequired = verifyStyle !== "none";

  return (
    <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Name</span>
        <input
          name="name"
          required
          placeholder="Stripe (prod)"
          className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Signature verification</span>
        <select
          name="verifyStyle"
          value={verifyStyle}
          onChange={(e) => setVerifyStyle(e.target.value)}
          className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="none">None</option>
          <option value="stripe">Stripe</option>
          <option value="github">GitHub</option>
          <option value="generic-sha256">Generic SHA-256</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        <span className="text-zinc-600 dark:text-zinc-400">
          Signing secret{" "}
          {secretRequired ? (
            <span className="text-zinc-400">(required for this verification style)</span>
          ) : (
            <span className="text-zinc-400">(only needed if verification is enabled)</span>
          )}
        </span>
        <input
          name="signingSecret"
          type="password"
          required={secretRequired}
          placeholder="whsec_..."
          className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      {state.error && (
        <p
          aria-live="polite"
          className="text-sm text-red-600 sm:col-span-2 dark:text-red-400"
        >
          {state.error}
        </p>
      )}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create source"}
        </button>
      </div>
    </form>
  );
}
