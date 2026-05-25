import { getConnection } from "../queue";
import type { AlertTrigger } from "./schema";

export function cooldownKey(destinationId: string, trigger: AlertTrigger): string {
  return `alert:cooldown:${destinationId}:${trigger}`;
}

/**
 * Atomically claim a per-(destination, trigger) cooldown for the next
 * `ttlSec` seconds. Returns true if the claim was won (caller should
 * proceed to dispatch), false if a prior claim is still live.
 *
 * Implemented via `SET key NX EX`, which is atomic across concurrent
 * workers. The claim is *not* released on dispatch failure — see
 * the design doc §7 "Cooldown semantics".
 */
export async function tryClaimCooldown(
  destinationId: string,
  trigger: AlertTrigger,
  ttlSec: number,
): Promise<boolean> {
  const key = cooldownKey(destinationId, trigger);
  const result = await getConnection().set(key, "1", "EX", ttlSec, "NX");
  return result === "OK";
}
