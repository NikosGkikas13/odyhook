import { prisma } from "../prisma";
import { parseStoredConfig, mergeAlertConfigs } from "./config";
import {
  shouldFireExhausted,
  shouldFireFailureRate,
  shouldFireFirstFailure,
  type DeliveryHistoryRow,
  type DeliveryStatus,
} from "./triggers";
import { getAlertsQueue, type AlertJob } from "./queue";
import type { AlertTrigger } from "./schema";

export type DeliveryOutcomeInput = {
  destinationId: string;
  deliveryId: string;
  outcomeStatus: DeliveryStatus;
  lastError?: string;
};

/**
 * Called by the delivery worker after every delivery completion (success
 * AND failure). Decides which triggers (if any) fire and enqueues one
 * AlertJob per firing trigger.
 *
 * History reads are kept minimal: we only load the recent window when at
 * least one trigger that needs it is enabled. History is ordered newest-first
 * (createdAt desc); the pure trigger functions in ./triggers rely on that.
 */
export async function maybeEnqueueAlerts(input: DeliveryOutcomeInput): Promise<void> {
  const dest = await prisma.destination.findUnique({
    where: { id: input.destinationId },
    select: {
      id: true,
      alertConfigJson: true,
      user: { select: { alertConfigJson: true } },
    },
  });
  if (!dest) return;

  const userCfg = parseStoredConfig(dest.user.alertConfigJson);
  const destCfg = parseStoredConfig(dest.alertConfigJson);
  const cfg = mergeAlertConfigs(userCfg, destCfg);
  const triggers = cfg.triggers ?? {};

  // If nothing is on, skip the history read entirely.
  const needsHistory =
    !!triggers.failureRate?.enabled || !!triggers.firstFailure?.enabled;

  let history: DeliveryHistoryRow[] = [];
  if (needsHistory) {
    const windowSize = Math.max(
      triggers.failureRate?.windowCount ?? 0,
      // firstFailure looks at prior N, so we need afterSuccessCount + 1 (the current)
      (triggers.firstFailure?.afterSuccessCount ?? 0) + 1,
    );
    if (windowSize > 0) {
      const rows = await prisma.delivery.findMany({
        where: { destinationId: input.destinationId },
        select: { id: true, status: true },
        orderBy: { createdAt: "desc" },
        take: windowSize,
      });
      history = rows.map((r) => ({
        id: r.id,
        status: r.status as DeliveryStatus,
      }));
    }
  }

  // For firstFailure we want the priors *excluding* the current delivery.
  const priorHistory = history.filter((r) => r.id !== input.deliveryId);

  const firedTriggers: AlertTrigger[] = [];

  if (
    shouldFireExhausted(triggers.exhausted, { status: input.outcomeStatus })
  ) {
    firedTriggers.push("exhausted");
  }
  if (shouldFireFailureRate(triggers.failureRate, history)) {
    firedTriggers.push("failureRate");
  }
  if (
    shouldFireFirstFailure(
      triggers.firstFailure,
      { status: input.outcomeStatus },
      priorHistory,
    )
  ) {
    firedTriggers.push("firstFailure");
  }

  if (firedTriggers.length === 0) return;

  const queue = getAlertsQueue();
  await Promise.all(
    firedTriggers.map((trigger) => {
      const data: AlertJob = {
        destinationId: input.destinationId,
        trigger,
        deliveryId: input.deliveryId,
        lastError: input.lastError,
        ...(trigger === "failureRate"
          ? {
              failureCount: history
                .slice(0, triggers.failureRate!.windowCount)
                .filter((r) => r.status === "failed" || r.status === "exhausted").length,
              windowSize: triggers.failureRate!.windowCount,
            }
          : {}),
        ...(trigger === "firstFailure"
          ? { afterSuccesses: triggers.firstFailure!.afterSuccessCount }
          : {}),
      };
      return queue.add(trigger, data);
    }),
  );
}
