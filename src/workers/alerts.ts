import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { Worker, type Job } from "bullmq";

import { prisma } from "../lib/prisma";
import { getConnection } from "../lib/queue";
import {
  ALERTS_QUEUE,
  getAlertsQueue,
  alertsBackoff,
  type AlertJob,
} from "../lib/alerts/queue";
import { parseStoredConfig, mergeAlertConfigs } from "../lib/alerts/config";
import { tryClaimCooldown } from "../lib/alerts/cooldown";
import {
  dispatchEmail,
  dispatchSlack,
  dispatchGenericWebhook,
} from "../lib/alerts/dispatch";
import type { AlertContext } from "../lib/alerts/compose";

/**
 * Process one alert job. Exported separately so tests can call it directly
 * without booting a Worker.
 */
export async function runAlertJob(job: AlertJob): Promise<void> {
  const dest = await prisma.destination.findUnique({
    where: { id: job.destinationId },
    select: {
      id: true,
      name: true,
      alertConfigJson: true,
      user: { select: { email: true, alertConfigJson: true } },
    },
  });
  if (!dest) {
    // Deleted between enqueue and process — drop silently.
    return;
  }

  const userCfg = parseStoredConfig(dest.user.alertConfigJson);
  const destCfg = parseStoredConfig(dest.alertConfigJson);
  const cfg = mergeAlertConfigs(userCfg, destCfg);

  const cooldownSec = (cfg.cooldownMinutes ?? 15) * 60;
  const claimed = await tryClaimCooldown(job.destinationId, job.trigger, cooldownSec);
  if (!claimed) {
    return;
  }

  const ctx: AlertContext = {
    destinationId: dest.id,
    destinationName: dest.name,
    trigger: job.trigger,
    deliveryId: job.deliveryId,
    lastError: job.lastError,
    failureCount: job.failureCount,
    windowSize: job.windowSize,
    afterSuccesses: job.afterSuccesses,
  };

  const tasks: Array<Promise<void>> = [];
  if (cfg.channels?.email?.enabled) {
    tasks.push(dispatchEmail(dest.user.email, ctx));
  }
  if (cfg.channels?.slack?.enabled) {
    tasks.push(dispatchSlack(cfg.channels.slack.webhookUrlEnc, ctx));
  }
  if (cfg.channels?.webhook?.enabled) {
    tasks.push(
      dispatchGenericWebhook(
        cfg.channels.webhook.urlEnc,
        cfg.channels.webhook.headersEnc,
        ctx,
      ),
    );
  }
  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failures.length > 0) {
    throw new Error(
      `alert dispatch had ${failures.length} failure(s): ${failures
        .map((f) => String(f.reason))
        .join("; ")}`,
    );
  }
}

let _worker: Worker<AlertJob> | null = null;

export function startAlertWorker(): Worker<AlertJob> {
  if (_worker) return _worker;
  _worker = new Worker<AlertJob>(
    ALERTS_QUEUE,
    async (job: Job<AlertJob>) => {
      await runAlertJob(job.data);
    },
    {
      connection: getConnection(),
      concurrency: 4,
      // Resolve the "alerts-staged" custom backoff registered in
      // src/lib/alerts/queue.ts. Without this, BullMQ throws
      // "Unknown backoff strategy alerts-staged" on the first retry.
      settings: {
        backoffStrategy: (attemptsMade: number) => alertsBackoff(attemptsMade),
      },
    },
  );
  _worker.on("ready", () => console.log("[alerts-worker] ready"));
  _worker.on("error", (err) => console.error("[alerts-worker] error:", err));
  _worker.on("failed", (job, err) => {
    console.error(`[alerts-worker] job ${job?.id} failed:`, err);
    // Only capture to Sentry after the job has truly exhausted its retries.
    // With `attempts: 4` in the queue, `attemptsMade` reaches 4 on the
    // final failure — a transient blip that succeeds on attempt 3 should
    // NOT page.
    const maxAttempts = job?.opts?.attempts ?? 4;
    if (job?.attemptsMade && job.attemptsMade >= maxAttempts) {
      Sentry.captureException(err, {
        tags: {
          destinationId: job.data.destinationId,
          trigger: job.data.trigger,
        },
      });
    }
  });
  return _worker;
}

export async function stopAlertWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  await getAlertsQueue().close();
}
