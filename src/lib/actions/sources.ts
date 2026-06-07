"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import {
  createSource as createSourceSvc,
  deleteSource as deleteSourceSvc,
  updateSource as updateSourceSvc,
  MAX_RETENTION_DAYS,
} from "@/lib/services/sources";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function createSource(formData: FormData) {
  const userId = await requireUserId();
  await createSourceSvc(userId, {
    name: String(formData.get("name") ?? ""),
    verifyStyle: String(formData.get("verifyStyle") ?? "none") as
      | "none" | "stripe" | "github" | "generic-sha256",
    signingSecret: formData.get("signingSecret")
      ? String(formData.get("signingSecret"))
      : undefined,
  });
  revalidatePath("/sources");
}

export async function deleteSource(formData: FormData) {
  const userId = await requireUserId();
  await deleteSourceSvc(userId, String(formData.get("id")));
  revalidatePath("/sources");
}

// Update a source's data-retention window. Empty input = keep indefinitely (null).
export async function updateSourceRetention(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id"));
  const raw = String(formData.get("retentionDays") ?? "").trim();

  let retentionDays: number | null;
  if (raw === "") {
    retentionDays = null;
  } else {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RETENTION_DAYS) {
      throw new Error(`Retention must be between 1 and ${MAX_RETENTION_DAYS} days, or blank for indefinite.`);
    }
    retentionDays = n;
  }

  await updateSourceSvc(userId, id, { retentionDays });
  revalidatePath(`/sources/${id}`);
}
