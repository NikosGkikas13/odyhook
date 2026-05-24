import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { verifySignature, type VerifyStyle } from "@/lib/hmac";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { getDeliveryQueue } from "@/lib/queue";
import { checkRateLimit, configForSource } from "@/lib/ratelimit";
import { redactSensitiveHeaders } from "@/lib/sensitive-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Max accepted ingest body. Anything over this is rejected before we
// allocate memory (or commit it to the bodyRaw TEXT column). Override
// with INGEST_MAX_BODY_BYTES if a tenant legitimately needs more.
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

function maxBodyBytes(): number {
  const raw = process.env.INGEST_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

// Stream the body into a single Buffer, aborting once `limit` is exceeded.
// Returns null when the cap is hit so the caller can 413 without consuming
// the rest of the upload.
async function readBodyWithLimit(
  req: Request,
  limit: number,
): Promise<{ ok: true; body: string } | { ok: false }> {
  if (!req.body) return { ok: true, body: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;

  const source = await prisma.source.findUnique({
    where: { slug },
    include: {
      routes: {
        // Skip routes whose destination is paused — those events simply
        // aren't queued. The destination toggle is the operator's "do not
        // deliver right now" switch; we don't want a backlog to drain
        // through it the moment they re-enable.
        where: { enabled: true, destination: { enabled: true } },
        include: { destination: true },
      },
    },
  });

  if (!source) {
    return NextResponse.json({ error: "unknown source" }, { status: 404 });
  }

  // Rate limit BEFORE reading the body — we want to shed load before
  // allocating memory for a large payload. Failures in the limiter (e.g.
  // Redis briefly unavailable) are logged and fail-open so we don't drop
  // legitimate traffic during a cache outage.
  try {
    const rl = await checkRateLimit(source.id, configForSource(source));
    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      return NextResponse.json(
        { error: "rate limited" },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  } catch (err) {
    console.error("[ingest] rate limiter error (failing open):", err);
  }

  const limit = maxBodyBytes();

  // Cheap pre-check on Content-Length. A liar can omit or under-declare,
  // so the streaming reader below also enforces the cap.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    return NextResponse.json(
      { error: "payload too large" },
      { status: 413, headers: { "X-Max-Bytes": String(limit) } },
    );
  }

  const read = await readBodyWithLimit(req, limit);
  if (!read.ok) {
    return NextResponse.json(
      { error: "payload too large" },
      { status: 413, headers: { "X-Max-Bytes": String(limit) } },
    );
  }
  const rawBody = read.body;

  // If verification is configured but the secret is missing, refuse to
  // ingest — silently accepting unsigned events would defeat the
  // verifyStyle setting. (createSource enforces this at the schema layer
  // for new sources; this guards rows that pre-date that fix.)
  if (source.verifyStyle && !source.signingSecret) {
    return NextResponse.json(
      { error: "source signing secret not configured" },
      { status: 503 },
    );
  }

  // Optional HMAC verification.
  if (source.signingSecret && source.verifyStyle) {
    try {
      const secret = decrypt(source.signingSecret);
      const ok = verifySignature(
        source.verifyStyle as VerifyStyle,
        rawBody,
        req.headers,
        secret,
      );
      if (!ok) {
        return NextResponse.json(
          { error: "invalid signature" },
          { status: 401 },
        );
      }
    } catch (err) {
      console.error("[ingest] signature verification error:", err);
      return NextResponse.json(
        { error: "signature verification failed" },
        { status: 500 },
      );
    }
  }

  // Capture inbound headers, but scrub credentials and source-side
  // signing values before they hit the event log — Event.headersJson
  // is long-lived and must not become a secret store.
  const rawHeadersObj: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    rawHeadersObj[k] = v;
  });
  const headersObj = redactSensitiveHeaders(rawHeadersObj);

  const remoteIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;

  // Dedupe identical re-sends from the source provider (Stripe/GitHub etc.
  // re-fire on their own retry schedules) by computing a stable per-source
  // key and reusing the prior event row if we've already seen it.
  const idempotencyKey = computeIdempotencyKey(
    req.headers,
    rawBody,
    source.verifyStyle,
  );

  const prior = await prisma.event.findUnique({
    where: {
      sourceId_idempotencyKey: { sourceId: source.id, idempotencyKey },
    },
    select: { id: true, _count: { select: { deliveries: true } } },
  });
  if (prior) {
    return NextResponse.json(
      {
        ok: true,
        eventId: prior.id,
        deliveries: prior._count.deliveries,
        duplicate: true,
      },
      { status: 200 },
    );
  }

  // Persist the event + one pending delivery per routed destination, then enqueue.
  // The unique index on (sourceId, idempotencyKey) handles the create-create race
  // when two concurrent retries arrive at the same instant — we catch P2002 and
  // return the prior row instead of inserting a duplicate.
  let event;
  try {
    event = await prisma.event.create({
      data: {
        sourceId: source.id,
        method: req.method,
        headersJson: headersObj,
        bodyRaw: rawBody,
        remoteIp,
        idempotencyKey,
        deliveries: {
          create: source.routes.map((r) => ({
            destinationId: r.destinationId,
            status: "pending",
          })),
        },
      },
      include: { deliveries: true },
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "P2002"
    ) {
      const dup = await prisma.event.findUnique({
        where: {
          sourceId_idempotencyKey: { sourceId: source.id, idempotencyKey },
        },
        select: { id: true, _count: { select: { deliveries: true } } },
      });
      if (dup) {
        return NextResponse.json(
          {
            ok: true,
            eventId: dup.id,
            deliveries: dup._count.deliveries,
            duplicate: true,
          },
          { status: 200 },
        );
      }
    }
    throw err;
  }

  // Enqueue one job per routed destination.
  const queue = getDeliveryQueue();
  await Promise.all(
    event.deliveries.map((d) =>
      queue.add("deliver", { deliveryId: d.id }),
    ),
  );

  return NextResponse.json(
    { ok: true, eventId: event.id, deliveries: event.deliveries.length },
    { status: 202 },
  );
}
