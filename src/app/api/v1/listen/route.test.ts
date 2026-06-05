import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { publishEvent, type LiveEvent } from "@/lib/events-pubsub";
import {
  acquireSseSlot,
  releaseSseSlot,
  maxStreamsPerUser,
} from "@/lib/sse-limit";
import { GET } from "./route";

async function makeUserWithToken() {
  const user = await prisma.user.create({
    data: { email: `h-listen-${Date.now()}-${Math.random()}@test.local` },
  });
  const t = generateToken();
  await prisma.apiToken.create({
    data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix },
  });
  return { user, raw: t.raw };
}

function req(url: string, raw: string | null, lastEventId?: string): Request {
  return new Request(url, {
    headers: {
      ...(raw ? { authorization: `Bearer ${raw}` } : {}),
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
  });
}
const ctx = { params: Promise.resolve({}) };

/**
 * Read SSE frames from `reader`, collecting `id:` values, until `done(ids)`
 * holds or the deadline passes. Heartbeat (`: ping`) frames carry no id and
 * are skipped. The read is bounded so a missing event fails fast, not hangs.
 */
async function readEventIds(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (ids: string[]) => boolean,
  timeoutMs = 3000,
): Promise<string[]> {
  const decoder = new TextDecoder();
  const ids: string[] = [];
  let pending = "";
  const deadline = Date.now() + timeoutMs;
  while (!done(ids) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    const frames = pending.split("\n\n");
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      const m = frame.match(/^id: (.+)$/m);
      if (m) ids.push(m[1]);
    }
  }
  return ids;
}

describe("GET /api/v1/listen", () => {
  it("401s without a token", async () => {
    const res = await GET(req("https://x/api/v1/listen?source=foo", null), ctx);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown source slug", async () => {
    const { raw } = await makeUserWithToken();
    const res = await GET(req("https://x/api/v1/listen?source=nope-nope", raw), ctx);
    expect(res.status).toBe(404);
  });

  it("404s for another user's source", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "A", slug: `a-${Date.now()}` },
    });
    const res = await GET(req(`https://x/api/v1/listen?source=${src.slug}`, b.raw), ctx);
    expect(res.status).toBe(404);
  });

  it("returns a text/event-stream for an owned source", async () => {
    const a = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "B", slug: `b-${Date.now()}` },
    });
    const res = await GET(req(`https://x/api/v1/listen?source=${src.slug}`, a.raw), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("backfills missed events then streams live events, exactly once each", async () => {
    const { user, raw } = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: user.id, name: "L", slug: `live-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    // A marker the client last saw, plus one event it missed while away.
    const marker = await prisma.event.create({
      data: { sourceId: src.id, method: "POST", headersJson: {}, bodyRaw: "{}", receivedAt: new Date(Date.now() - 2000) },
    });
    const missed = await prisma.event.create({
      data: { sourceId: src.id, method: "POST", headersJson: {}, bodyRaw: '{"k":1}', receivedAt: new Date(Date.now() - 1000) },
    });

    const res = await GET(
      req(`https://x/api/v1/listen?source=${src.slug}`, raw, marker.id),
      ctx,
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      // Backfill delivers the missed event (and not the marker itself).
      const backfill = await readEventIds(reader, (ids) => ids.includes(missed.id));
      expect(backfill).toContain(missed.id);
      expect(backfill).not.toContain(marker.id);

      // The subscription is active before backfill runs, so a live publish
      // now is delivered — exactly once, and the backfilled id isn't repeated.
      const live: LiveEvent = {
        id: "live-evt-1",
        method: "POST",
        headersJson: {},
        bodyRaw: "{}",
        receivedAt: new Date().toISOString(),
      };
      await publishEvent(src.id, live);
      const liveIds = await readEventIds(reader, (ids) => ids.includes(live.id));

      const all = [...backfill, ...liveIds];
      expect(all.filter((i) => i === live.id)).toHaveLength(1);
      expect(all.filter((i) => i === missed.id)).toHaveLength(1);
    } finally {
      await reader.cancel();
    }
  });

  it("429s once the per-user concurrent-stream cap is reached", async () => {
    const { user, raw } = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: user.id, name: "C", slug: `c-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    // Saturate the user's slots; the handler must reject before opening a stream.
    const cap = maxStreamsPerUser();
    for (let i = 0; i < cap; i++) acquireSseSlot(user.id);
    try {
      const res = await GET(req(`https://x/api/v1/listen?source=${src.slug}`, raw), ctx);
      expect(res.status).toBe(429);
    } finally {
      for (let i = 0; i < cap; i++) releaseSseSlot(user.id);
    }
  });
});
