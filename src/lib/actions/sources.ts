"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import {
  createSource as createSourceSvc,
  deleteSource as deleteSourceSvc,
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
