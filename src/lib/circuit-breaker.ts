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

export async function recordSuccess(destinationId: string): Promise<void> {
  // Always write — the row is hot and the write is cheap; not worth
  // reading first to avoid a no-op update.
  await prisma.destination.update({
    where: { id: destinationId },
    data: { consecutiveFailures: 0 },
  });
}
