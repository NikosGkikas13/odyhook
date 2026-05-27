import type { AlertConfig } from "./schema";

// Minimal slice of a Delivery row that the trigger functions need. Kept
// narrow so the pure-function layer doesn't depend on Prisma types.
export type DeliveryStatus =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed"
  | "exhausted";

export type DeliveryHistoryRow = {
  id: string;
  status: DeliveryStatus;
};

export type CurrentOutcome = {
  status: DeliveryStatus;
};

function isFailure(s: DeliveryStatus): boolean {
  return s === "failed" || s === "exhausted";
}

export function shouldFireExhausted(
  cfg: AlertConfig["triggers"] extends infer T
    ? T extends { exhausted?: infer E }
      ? E
      : undefined
    : undefined,
  outcome: CurrentOutcome,
): boolean {
  if (!cfg?.enabled) return false;
  return outcome.status === "exhausted";
}

export function shouldFireFailureRate(
  cfg: AlertConfig["triggers"] extends infer T
    ? T extends { failureRate?: infer F }
      ? F
      : undefined
    : undefined,
  history: DeliveryHistoryRow[],
): boolean {
  if (!cfg?.enabled) return false;
  if (history.length < cfg.windowCount) return false;
  const window = history.slice(0, cfg.windowCount);
  const failures = window.filter((r) => isFailure(r.status)).length;
  const pct = (failures / window.length) * 100;
  return pct >= cfg.ratePct;
}

export function shouldFireFirstFailure(
  cfg: AlertConfig["triggers"] extends infer T
    ? T extends { firstFailure?: infer F }
      ? F
      : undefined
    : undefined,
  outcome: CurrentOutcome,
  priorHistory: DeliveryHistoryRow[],
): boolean {
  if (!cfg?.enabled) return false;
  if (!isFailure(outcome.status)) return false;
  if (priorHistory.length < cfg.afterSuccessCount) return false;
  const window = priorHistory.slice(0, cfg.afterSuccessCount);
  return window.every((r) => r.status === "delivered");
}
