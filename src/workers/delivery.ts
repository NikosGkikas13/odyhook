// Delivery worker — runs as a separate process: `npm run worker`
// Polls the BullMQ delivery queue, posts each event to its destination,
// and reschedules retries with exponential backoff on failure.

import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { Worker, type Job } from "bullmq";

// Initialise Sentry early so any import-time errors below are captured.
// Disabled automatically when SENTRY_DSN is unset (local dev).
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
});

import { prisma } from "../lib/prisma";
import { decryptJson } from "../lib/crypto";
import { runTransformation } from "../lib/sandbox/quickjs";
import { evaluateFilter, type FilterAst } from "../lib/filters/evaluator";
import { assertSafeUrl, SsrfError } from "../lib/ssrf";
import { SENSITIVE_HEADERS } from "../lib/sensitive-headers";
import {
  DELIVERY_QUEUE,
  MAX_ATTEMPTS,
  backoffForAttempt,
  getConnection,
  getDeliveryQueue,
  type DeliveryJob,
} from "../lib/queue";

// Headers that should never be forwarded to the destination. Combines:
//   1. Hop-by-hop / framing — re-derived per request by fetch().
//   2. Sensitive — credentials and source-side signing headers shared
//      with the persistence layer via SENSITIVE_HEADERS so the two
//      lists stay in sync.
// Destination static headers overlay this set, so a destination can
// still attach its own auth.
const HOP_BY_HOP_HEADERS = [
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];
const DROP_HEADERS = new Set([...HOP_BY_HOP_HEADERS, ...SENSITIVE_HEADERS]);

function sanitizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v) continue;
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

async function processDelivery(job: Job<DeliveryJob>) {
  const { deliveryId } = job.data;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: {
      event: true,
      destination: true,
    },
  });

  if (!delivery) {
    // Delivery was deleted between enqueue and processing — skip silently.
    return;
  }
  if (delivery.status === "delivered" || delivery.status === "exhausted") {
    return;
  }

  // Look up the Route (source→destination) to pick up any attached
  // transformation and filter AST. A delivery may exist without a matching
  // route if the route was deleted mid-flight — in that case we just forward
  // the raw body with no transform/filter.
  const route = await prisma.route.findUnique({
    where: {
      sourceId_destinationId: {
        sourceId: delivery.event.sourceId,
        destinationId: delivery.destinationId,
      },
    },
    include: { transformation: true },
  });

  // Apply NL-compiled filter first — if it evaluates false, skip delivery
  // entirely and mark it delivered (non-failure: the rule said "don't send").
  if (route?.filterAst) {
    try {
      let parsedEvent: unknown = {};
      try {
        parsedEvent = JSON.parse(delivery.event.bodyRaw);
      } catch {
        parsedEvent = { raw: delivery.event.bodyRaw };
      }
      const passes = evaluateFilter(
        route.filterAst as unknown as FilterAst,
        parsedEvent,
      );
      if (!passes) {
        await prisma.delivery.update({
          where: { id: deliveryId },
          data: {
            status: "delivered",
            responseCode: null,
            responseBodySnippet: "[skipped by filter]",
            deliveredAt: new Date(),
            lastError: null,
            nextRetryAt: null,
          },
        });
        console.log(`[worker] ${deliveryId} skipped by filter`);
        return;
      }
    } catch (err) {
      console.error(`[worker] filter error for ${deliveryId}:`, err);
      // Fall through and deliver — a broken filter should not block events.
    }
  }

  // Mark in-flight up front so concurrent BullMQ retries don't
  // double-process. attemptCount is *not* incremented here: a worker
  // that crashes mid-fetch would otherwise burn an attempt without
  // having made the HTTP call. The terminal updates below increment.
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { status: "in_flight" },
  });

  const attempt = delivery.attemptCount + 1; // this attempt's number

  // Forward headers: preserve original request headers, overlay destination static headers.
  const eventHeaders = sanitizeHeaders(
    delivery.event.headersJson as Record<string, string | string[] | undefined>,
  );
  let destHeaders: Record<string, string> = {};
  if (delivery.destination.headersEnc) {
    try {
      destHeaders = decryptJson<Record<string, string>>(
        delivery.destination.headersEnc,
      );
    } catch (err) {
      console.error(
        `[worker] failed to decrypt destination headers for ${delivery.destinationId}:`,
        err,
      );
    }
  }
  const headers = { ...eventHeaders, ...destHeaders };

  // Apply transformation if the route has one. If the sandbox fails, treat
  // it as a delivery failure with a descriptive error so the retry schedule
  // still kicks in (and the user can see it in the dashboard).
  let body: string = delivery.event.bodyRaw;
  let transformError: string | null = null;
  if (route?.transformation) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(delivery.event.bodyRaw);
    } catch {
      parsed = { raw: delivery.event.bodyRaw };
    }
    const result = await runTransformation(
      route.transformation.codeJs,
      parsed,
    );
    if (result.ok) {
      body = JSON.stringify(result.value);
      // Content-length is dropped by sanitizeHeaders; content-type defaults
      // to the inbound value but we normalise to JSON for transformed payloads.
      headers["content-type"] = "application/json";
    } else {
      transformError = `transform failed: ${result.error}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    delivery.destination.timeoutMs ?? 10_000,
  );

  let responseCode: number | null = null;
  let responseSnippet: string | null = null;
  let errorMsg: string | null = transformError;
  // Set when failure should not be retried — currently only SSRF rejections,
  // since the destination URL is constant across retries.
  let terminal = false;

  if (transformError) {
    // Skip the fetch entirely — fall through to the failure/retry branch.
    clearTimeout(timeout);
  } else try {
    // Re-validate at delivery time: defends against DNS rebinding, and
    // catches destinations that were created before the SSRF guard landed.
    await assertSafeUrl(delivery.destination.url);
    const res = await fetch(delivery.destination.url, {
      method: delivery.event.method,
      headers,
      body,
      signal: controller.signal,
    });
    responseCode = res.status;
    const text = await res.text().catch(() => "");
    responseSnippet = text.slice(0, 2048);
    if (!res.ok) {
      errorMsg = `HTTP ${res.status}`;
    }
  } catch (err) {
    if (err instanceof SsrfError) {
      errorMsg = `blocked by SSRF guard: ${err.message}`;
      terminal = true;
    } else {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!errorMsg) {
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: "delivered",
        attemptCount: { increment: 1 },
        responseCode,
        responseBodySnippet: responseSnippet,
        deliveredAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      },
    });
    console.log(`[worker] delivered ${deliveryId} (${responseCode})`);
    return;
  }

  // Failure path — decide retry vs exhaust.
  if (terminal || attempt >= MAX_ATTEMPTS) {
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: "exhausted",
        attemptCount: { increment: 1 },
        responseCode,
        responseBodySnippet: responseSnippet,
        lastError: errorMsg,
        nextRetryAt: null,
      },
    });
    console.warn(
      `[worker] exhausted ${deliveryId}${terminal ? " (terminal)" : ` after ${attempt} attempts`}: ${errorMsg}`,
    );
    return;
  }

  const delayMs = backoffForAttempt(attempt);
  const nextRetryAt = new Date(Date.now() + delayMs);
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: "failed",
      attemptCount: { increment: 1 },
      responseCode,
      responseBodySnippet: responseSnippet,
      lastError: errorMsg,
      nextRetryAt,
    },
  });
  await getDeliveryQueue().add(
    "deliver",
    { deliveryId },
    { delay: delayMs },
  );
  console.warn(
    `[worker] retry ${deliveryId} in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS}): ${errorMsg}`,
  );
}

const worker = new Worker<DeliveryJob>(DELIVERY_QUEUE, processDelivery, {
  connection: getConnection(),
  concurrency: 8,
});

worker.on("ready", () => {
  console.log("[worker] ready");
});
worker.on("error", (err) => {
  console.error("[worker] error:", err);
});
worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err);
});

// Reaper: re-enqueue deliveries that have been stuck in `pending` for
// too long. Covers the gap between `prisma.event.create` and
// `queue.add` in the ingest handler — if the enqueue fails (Redis
// hiccup, process crash mid-call), the row exists in Postgres but no
// job exists in BullMQ. Without this loop those rows would never be
// processed.
//
// Only `pending` is reaped here. `in_flight` orphans from a crashed
// worker are handled by BullMQ's own stalled-job detection (lock
// expiry re-queues the job), and reaping them in parallel risks
// double-delivery while the original worker is still alive.
const REAPER_INTERVAL_MS = Number(
  process.env.DELIVERY_REAPER_INTERVAL_MS ?? 60_000,
);
const PENDING_GRACE_MS = Number(
  process.env.DELIVERY_PENDING_GRACE_MS ?? 120_000,
);
const REAPER_BATCH_SIZE = 200;

async function reapStalledDeliveries() {
  const cutoff = new Date(Date.now() - PENDING_GRACE_MS);
  const stalled = await prisma.delivery.findMany({
    where: {
      status: "pending",
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    take: REAPER_BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });
  if (stalled.length === 0) return;
  const queue = getDeliveryQueue();
  await Promise.all(
    stalled.map((d) =>
      queue.add(
        "deliver",
        { deliveryId: d.id },
        { jobId: `reap:${d.id}:${Date.now()}` },
      ),
    ),
  );
  console.log(`[worker] reaper re-enqueued ${stalled.length} stalled deliveries`);
}

const reaperTimer = setInterval(() => {
  reapStalledDeliveries().catch((err) => {
    console.error("[worker] reaper error:", err);
  });
}, REAPER_INTERVAL_MS);
// Don't keep the event loop alive on shutdown.
reaperTimer.unref?.();

async function shutdown() {
  console.log("[worker] shutting down...");
  clearInterval(reaperTimer);
  await worker.close();
  await getDeliveryQueue().close();
  await getConnection().quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
