import { z } from "zod";

import { QuotaExceededError } from "@/lib/quota";

/** Shared shape for `useActionState`-driven form actions. */
export type FormState = { error?: string; ok?: boolean };

/**
 * Map a thrown error to a user-facing form message, or `null` when the error
 * is unexpected and should bubble to the nearest `error.tsx` boundary.
 *
 * Next models *expected* errors (validation, quota limits) as action return
 * values rather than thrown exceptions — see the framework's error-handling
 * guide. Only genuine bugs should reach an error boundary, so callers do:
 *
 *   const msg = toFormError(err);
 *   if (msg === null) throw err; // unexpected → error boundary
 *   return { error: msg };       // expected → show on the form
 */
export function toFormError(err: unknown): string | null {
  if (err instanceof z.ZodError) {
    return err.issues[0]?.message ?? "Invalid input.";
  }
  if (err instanceof QuotaExceededError) {
    return err.message;
  }
  return null;
}
