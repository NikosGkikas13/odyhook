import { Queue } from "bullmq";
import { getConnection } from "../queue";
import type { AlertTrigger } from "./schema";

export const ALERTS_QUEUE = "odyhook.alerts";

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

export function getAlertsQueue(): Queue<AlertJob> {
  if (!_alertsQueue) {
    _alertsQueue = new Queue<AlertJob>(ALERTS_QUEUE, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  return _alertsQueue;
}
