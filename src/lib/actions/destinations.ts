"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  createDestination as createDestinationSvc,
  deleteDestination as deleteDestinationSvc,
} from "@/lib/services/destinations";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function createDestination(formData: FormData) {
  const userId = await requireUserId();
  await createDestinationSvc(userId, {
    name: String(formData.get("name") ?? ""),
    url: String(formData.get("url") ?? ""),
    timeoutMs: formData.get("timeoutMs") ? Number(formData.get("timeoutMs")) : 10_000,
    headers: String(formData.get("headers") ?? ""),
    outboundSecret: String(formData.get("outboundSecret") ?? ""),
  });
  revalidatePath("/destinations");
}

export async function deleteDestination(formData: FormData) {
  const userId = await requireUserId();
  await deleteDestinationSvc(userId, String(formData.get("id")));
  revalidatePath("/destinations");
}

/**
 * Pause/resume a destination. When `enabled=false`, the ingest handler
 * skips creating deliveries for it and the worker refuses any already-
 * enqueued ones, leaving them as `exhausted` with a "destination paused"
 * error that the user can re-replay after re-enabling.
 */
export async function toggleDestinationEnabled(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id"));
  const existing = await prisma.destination.findFirst({
    where: { id, userId },
    select: { enabled: true },
  });
  if (!existing) throw new Error("not found");

  const nextEnabled = !existing.enabled;
  // Resuming a destination (false → true) clears the breaker state so it
  // gets a fresh failure window. Pausing leaves the counter alone — an
  // operator pause shouldn't pardon prior failures.
  const data = nextEnabled
    ? { enabled: true, consecutiveFailures: 0, autoDisabledAt: null, autoDisabledReason: null }
    : { enabled: false };

  await prisma.destination.update({ where: { id }, data });
  revalidatePath("/destinations");
}
