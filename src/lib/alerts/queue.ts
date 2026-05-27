import { Queue } from "bullmq";
import { getConnection } from "../queue";
import type { AlertTrigger } from "./schema";

export const ALERTS_QUEUE = "odyhook.alerts";

// Backoff schedule in ms for retried alert dispatches. Generous enough to
// ride through transient Slack 429s, SMTP relay outages, and 1-2 minute
// downstream blips without losing the alert.
//
// One initial attempt + 3 retries (attempts: 4). attemptsMade is 1-indexed
// (the attempt that just failed). BullMQ's default `exponential` strategy
// cannot produce this irregular shape on its own, so we register a custom
// strategy on the worker (see src/workers/alerts.ts) that calls this.
export const ALERTS_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

export function alertsBackoff(attemptsMade: number): number {
  const idx = Math.min(
    Math.max(0, attemptsMade - 1),
    ALERTS_RETRY_DELAYS_MS.length - 1,
  );
  return ALERTS_RETRY_DELAYS_MS[idx];
}

export type AlertJob = {
  destinationId: string;
  trigger: AlertTrigger;
  deliveryId: string;
  lastError?: string;
  failureCount?: number;
  windowSize?: number;
  afterSuccesses?: number;
};

let _alertsQueue: Queue<AlertJob> | null = null;

// Lazy — opening the Redis connection at module load would break `next build`.
// See ../queue.ts for the rationale.
export function getAlertsQueue(): Queue<AlertJob> {
  if (!_alertsQueue) {
    _alertsQueue = new Queue<AlertJob>(ALERTS_QUEUE, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 4, // 1 initial + 3 retries
        backoff: { type: "alerts-staged" },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  return _alertsQueue;
}
