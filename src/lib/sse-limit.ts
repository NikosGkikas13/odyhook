// Per-user cap on concurrent Server-Sent-Events streams (GET /api/v1/listen).
//
// Each stream holds a dedicated Redis connection (getConnection().duplicate())
// plus a heartbeat timer for its whole lifetime, and withApiAuth only limits the
// *rate* of opening — not the *count* held open. One user (or a leaked token)
// could open thousands and exhaust Redis maxclients / process FDs.
//
// The deployment runs a single web container, so an in-process per-user counter
// is accurate; a crash clears the map and kills the streams together, so there's
// nothing to leak. (If web ever scales horizontally this becomes a per-process
// cap — still a graceful bound, just coarser.)

const counts = new Map<string, number>();

export function maxStreamsPerUser(): number {
  const n = Number(process.env.SSE_MAX_STREAMS_PER_USER ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** Reserve a stream slot for `userId`. Returns false if the cap is reached. */
export function acquireSseSlot(
  userId: string,
  max: number = maxStreamsPerUser(),
): boolean {
  const cur = counts.get(userId) ?? 0;
  if (cur >= max) return false;
  counts.set(userId, cur + 1);
  return true;
}

/** Release a previously-acquired slot. Idempotent below zero. */
export function releaseSseSlot(userId: string): void {
  const cur = counts.get(userId) ?? 0;
  if (cur <= 1) counts.delete(userId);
  else counts.set(userId, cur - 1);
}

export function activeSseCount(userId: string): number {
  return counts.get(userId) ?? 0;
}
