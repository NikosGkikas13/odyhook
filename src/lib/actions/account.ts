"use server";

import { auth, signOut } from "@/auth";
import { deleteUserAccount } from "@/lib/services/account";

/**
 * GDPR Art. 17 erasure. Deletes the signed-in user's account; every owned row
 * (sources, destinations, routes, events, deliveries, tokens, keys, …) is
 * removed by the `onDelete: Cascade` relations in schema.prisma. Then signs the
 * user out and redirects home.
 *
 * Requires the user to re-type their exact account email as confirmation — this
 * is irreversible. Server actions get framework CSRF protection, so no explicit
 * origin check is needed here.
 */
export async function deleteAccount(formData: FormData) {
  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email;
  if (!userId || !email) throw new Error("unauthorized");

  const confirm = String(formData.get("confirmEmail") ?? "").trim();
  if (confirm.toLowerCase() !== email.toLowerCase()) {
    throw new Error("Type your account email exactly to confirm deletion.");
  }

  await deleteUserAccount(userId);

  // Clears the session cookie/JWT and redirects to the marketing home page.
  // Throws NEXT_REDIRECT, which Next handles — must be the last call.
  await signOut({ redirectTo: "/" });
}
