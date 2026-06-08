"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import type { Provider } from "@/lib/llm";

const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

// Order matters: openrouter's "sk-or-" is a superset of openai's "sk-".
const PREFIX: Record<Provider, string> = {
  anthropic: "sk-ant-",
  openrouter: "sk-or-",
  openai: "sk-",
  google: "AIza",
};

export function validateProviderKey(
  provider: string,
  key: string,
  model: string | null,
): { ok: true } | { ok: false; error: string } {
  if (!PROVIDERS.includes(provider as Provider)) {
    return { ok: false, error: "Unknown provider." };
  }
  const p = provider as Provider;
  if (!key.startsWith(PREFIX[p])) {
    return { ok: false, error: `That doesn't look like a ${p} key (expected ${PREFIX[p]}…).` };
  }
  if (p === "openrouter" && !model?.trim()) {
    return { ok: false, error: "OpenRouter requires a model id (e.g. meta-llama/llama-3.3-70b-instruct)." };
  }
  return { ok: true };
}

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function saveProviderKey(formData: FormData) {
  const userId = await requireUserId();
  const provider = String(formData.get("provider") ?? "");
  const key = String(formData.get("apiKey") ?? "").trim();
  const modelRaw = String(formData.get("model") ?? "").trim();
  const model = modelRaw === "" ? null : modelRaw;

  const v = validateProviderKey(provider, key, model);
  if (!v.ok) throw new Error(v.error);
  const p = provider as Provider;

  await prisma.providerKey.upsert({
    where: { userId_provider: { userId, provider: p } },
    create: { userId, provider: p, keyEnc: encrypt(key), model },
    update: { keyEnc: encrypt(key), model },
  });

  // If the user has no active provider yet, make this one active.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeAiProvider: true },
  });
  if (!user?.activeAiProvider) {
    await prisma.user.update({ where: { id: userId }, data: { activeAiProvider: p } });
  }

  revalidatePath("/settings/api-keys");
}

export async function setActiveProvider(formData: FormData) {
  const userId = await requireUserId();
  const provider = String(formData.get("provider") ?? "") as Provider;
  const row = await prisma.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row) throw new Error("No saved key for that provider.");
  await prisma.user.update({ where: { id: userId }, data: { activeAiProvider: provider } });
  revalidatePath("/settings/api-keys");
}

export async function deleteProviderKey(formData: FormData) {
  const userId = await requireUserId();
  const provider = String(formData.get("provider") ?? "") as Provider;

  await prisma.providerKey.deleteMany({ where: { userId, provider } });

  // If we deleted the active provider, repoint to any remaining key, else null.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeAiProvider: true },
  });
  if (user?.activeAiProvider === provider) {
    const remaining = await prisma.providerKey.findFirst({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { provider: true },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { activeAiProvider: remaining?.provider ?? null },
    });
  }

  revalidatePath("/settings/api-keys");
}
