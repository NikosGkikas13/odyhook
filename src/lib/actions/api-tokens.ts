"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import {
  createTokenForUser,
  listTokensForUser,
  revokeTokenForUser,
} from "@/lib/services/api-tokens";

// NOTE: do NOT re-export the *ForUser helpers from this "use server" file —
// doing so would expose them as client-callable server actions that accept an
// arbitrary userId with no session check (privilege escalation). They're
// imported for internal use only; tests import them from the service module.
export type { ApiTokenSummary } from "@/lib/services/api-tokens";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

// ---- Server Actions used by the settings page form ----

/** Returns the raw token string ONCE for display. */
export async function createApiToken(formData: FormData): Promise<{ token: string }> {
  const userId = await requireUserId();
  const { token } = await createTokenForUser(userId, String(formData.get("name") ?? ""));
  revalidatePath("/settings/api-tokens");
  return { token };
}

export async function revokeApiToken(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  await revokeTokenForUser(userId, String(formData.get("id")));
  revalidatePath("/settings/api-tokens");
}
