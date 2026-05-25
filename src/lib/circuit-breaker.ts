// Circuit breaker for destination health.
//
// On every exhausted delivery we increment `consecutiveFailures` on the
// destination. On every successful delivery we reset it to 0. When the
// count crosses DESTINATION_FAILURE_THRESHOLD we flip `enabled` to false
// (atomically, so concurrent workers race safely) and email the owner.
//
// "Exhausted" means all retries finished without a 2xx — by then the
// worker has already made up to MAX_ATTEMPTS HTTP calls per delivery, so
// the default threshold of 5 corresponds to dozens of attempts before we
// give up on the destination.

import { prisma } from "./prisma";

const DEFAULT_THRESHOLD = 5;

export function getFailureThreshold(): number {
  const raw = process.env.DESTINATION_FAILURE_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_THRESHOLD;
  return Math.floor(n);
}

// Always write — the row is hot and the write is cheap; not worth
// reading first to avoid a no-op update. Throws Prisma `P2025` if the
// destination was deleted between enqueue and call; callers in the
// hot path should wrap with try/catch.
export async function recordSuccess(destinationId: string): Promise<void> {
  await prisma.destination.update({
    where: { id: destinationId },
    data: { consecutiveFailures: 0 },
  });
}

export type TripResult =
  | { tripped: false }
  | { tripped: true; destinationName: string; ownerEmail: string };

export async function recordExhausted(
  destinationId: string,
  errorMsg: string,
): Promise<TripResult> {
  const threshold = getFailureThreshold();

  // Step 1: bump the counter only if the destination is still enabled.
  // If it's already disabled (manual pause or earlier trip from a sibling
  // worker) we leave it alone — the operator is in control.
  //
  // Non-idempotent by design: BullMQ provides at-least-once delivery, so a
  // worker crash between Postgres write and queue ack can re-fire this for
  // the same delivery and double-count. Acceptable because the threshold
  // (default 5) is conservative — one extra increment in a crash scenario
  // does not meaningfully shift when the breaker trips.
  const bumped = await prisma.destination.updateMany({
    where: { id: destinationId, enabled: true },
    data: { consecutiveFailures: { increment: 1 } },
  });
  if (bumped.count === 0) return { tripped: false };

  // Step 2: atomic trip — flip enabled to false ONLY IF the counter is
  // now at or past the threshold AND the row is still enabled. The
  // updateMany predicate is the race lock: with two concurrent callers,
  // Postgres will serialize and only one will see `enabled=true` at
  // write time, so only one trips.
  const tripped = await prisma.destination.updateMany({
    where: {
      id: destinationId,
      enabled: true,
      consecutiveFailures: { gte: threshold },
    },
    data: {
      enabled: false,
      autoDisabledAt: new Date(),
      autoDisabledReason: errorMsg.slice(0, 500),
    },
  });
  if (tripped.count === 0) return { tripped: false };

  // The trip happened on this call — load owner info for the notifier.
  const d = await prisma.destination.findUniqueOrThrow({
    where: { id: destinationId },
    select: { name: true, user: { select: { email: true } } },
  });
  return { tripped: true, destinationName: d.name, ownerEmail: d.user.email };
}
