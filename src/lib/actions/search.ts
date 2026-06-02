"use server";

import { auth } from "@/auth";
import { NoUserApiKeyError } from "@/lib/anthropic";
import { compileSearchForUser } from "@/lib/services/search";
import { SearchCompileError } from "@/lib/ai/search-compiler";
import type { EventQuery } from "@/lib/search/types";

export type PreviewResult =
  | { ok: true; query: EventQuery; summary: string[] }
  | { ok: false; error: string };

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

/** Compile an NL search to a query + chips (preview only — does not run it). */
export async function previewSearch(prompt: string, timeZone: string): Promise<PreviewResult> {
  const trimmed = prompt.trim();
  if (!trimmed) return { ok: false, error: "Enter a search to compile." };

  const userId = await requireUserId();
  try {
    const { query, summary } = await compileSearchForUser(userId, trimmed, { timeZone });
    return { ok: true, query, summary };
  } catch (e) {
    if (e instanceof NoUserApiKeyError) {
      return { ok: false, error: "No Anthropic API key configured. Set one in Settings → API Keys." };
    }
    if (e instanceof SearchCompileError) {
      return { ok: false, error: "Couldn't interpret that search. Try rephrasing." };
    }
    throw e; // unexpected → surfaces as a 500
  }
}
