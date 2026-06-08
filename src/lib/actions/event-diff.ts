"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { llmFor } from "@/lib/llm";
import {
  explainEventDiff,
  canonicalPair,
  type DiffChange,
  type DiffResult,
} from "@/lib/ai/event-diff";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

/** What the UI consumes — the persisted/diff fields without the model id. */
export type EventDiffView = { summary: string; changes: DiffChange[] };

/**
 * Explain what changed between two events the user owns. Canonicalizes the
 * pair older→newer, returns a cached AiEventDiff if one exists, otherwise calls
 * Claude (BYOK) and persists the result. Re-opening the same compare URL is
 * free after the first generation.
 */
export async function explainEventDiffAction(
  aId: string,
  bId: string,
): Promise<EventDiffView> {
  const userId = await requireUserId();

  if (aId === bId) throw new Error("cannot compare an event with itself");

  const events = await prisma.event.findMany({
    where: { id: { in: [aId, bId] }, source: { userId } },
    select: { id: true, receivedAt: true, bodyRaw: true },
  });
  if (events.length !== 2) throw new Error("event not found");

  const [e0, e1] = events;
  const { olderId, newerId } = canonicalPair(e0, e1);
  const older = e0.id === olderId ? e0 : e1;
  const newer = e0.id === newerId ? e0 : e1;

  // Cache hit — return without spending tokens.
  const cached = await prisma.aiEventDiff.findUnique({
    where: { eventAId_eventBId: { eventAId: olderId, eventBId: newerId } },
  });
  if (cached) {
    return {
      summary: cached.summary,
      changes: cached.changes as unknown as DiffChange[],
    };
  }

  const llm = await llmFor(userId);
  const result: DiffResult = await explainEventDiff({
    llm,
    bodyA: older.bodyRaw,
    bodyB: newer.bodyRaw,
  });

  await prisma.aiEventDiff.create({
    data: {
      eventAId: olderId,
      eventBId: newerId,
      summary: result.summary,
      changes: result.changes as unknown as object,
      modelUsed: result.modelUsed,
    },
  });

  revalidatePath("/events/compare");
  return { summary: result.summary, changes: result.changes };
}
