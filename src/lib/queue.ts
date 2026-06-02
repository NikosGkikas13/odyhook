import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";

export const DELIVERY_QUEUE = "odyhook.delivery";

// Exponential backoff schedule in ms — one delay per retry.
// Order: 10s, 30s, 2m, 10m, 1h, 6h. One initial attempt + 6 retries (7 total).
export const RETRY_DELAYS_MS = [
  10_000,
  30_000,
  120_000,
  600_000,
  3_600_000,
  21_600_000,
];

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export type DeliveryJob = {
  deliveryId: string;
};

// Lazy singletons — do not open a Redis connection at module load time,
// because that would break `next build` (page data collection) and any
// other process that merely imports this file.

let _connection: Redis | null = null;
let _queue: Queue<DeliveryJob> | null = null;

export function getConnection(): Redis {
  if (!_connection) {
    const conn = new IORedis(
      process.env.REDIS_URL ?? "redis://localhost:6379",
      { maxRetriesPerRequest: null },
    );
    // ioredis reconnects forever silently by default. Log so a flapping
    // Redis is visible in operator logs instead of just manifesting as
    // hung BullMQ jobs and rate-limit fail-opens.
    conn.on("error", (err) => {
      console.error("[redis] error:", err.message);
    });
    conn.on("reconnecting", (delay: number) => {
      console.warn(`[redis] reconnecting in ${delay}ms`);
    });
    conn.on("end", () => {
      console.warn("[redis] connection closed");
    });
    _connection = conn;
  }
  return _connection;
}

export function getDeliveryQueue(): Queue<DeliveryJob> {
  if (!_queue) {
    _queue = new Queue<DeliveryJob>(DELIVERY_QUEUE, {
      connection: getConnection(),
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return _queue;
}

/**
 * Backoff before the next retry. `attempt` is the 1-indexed number of the
 * attempt that just failed (matching `delivery.attemptCount + 1` at the call
 * site), so the first failed attempt waits RETRY_DELAYS_MS[0] (10s). Clamped
 * at both ends.
 */
export function backoffForAttempt(attempt: number): number {
  const idx = Math.min(
    Math.max(0, attempt - 1),
    RETRY_DELAYS_MS.length - 1,
  );
  return RETRY_DELAYS_MS[idx];
}
