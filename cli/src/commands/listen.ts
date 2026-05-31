import { parseArgs } from "node:util";

import { loadConfig, type Config } from "../config.js";
import { apiUrl, authHeaders, resolveSourceId } from "../http.js";
import { SSEParser } from "../sse.js";
import { forwardEvent, type EventPayload, type ForwardResult } from "../forward.js";
import { parseDuration } from "../duration.js";

type Forwarder = (e: EventPayload) => Promise<ForwardResult>;

/**
 * Read an SSE byte stream, parse frames, and forward each event. Returns the
 * id of the last event seen (for Last-Event-ID resume). Exported for testing.
 */
export async function consumeStream(
  body: ReadableStream<Uint8Array>,
  forward: Forwarder,
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  let lastId: string | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const events = parser.push(decoder.decode(value, { stream: true }));
    for (const frame of events) {
      if (frame.id) lastId = frame.id;
      let payload: EventPayload;
      try {
        payload = JSON.parse(frame.data) as EventPayload;
      } catch {
        continue;
      }
      const res = await forward(payload);
      if (res.ok) {
        console.log(`✓ ${res.status}  ${res.ms}ms  ${payload.id}`);
      } else {
        console.error(`✗ ${res.error}  ${payload.id}`);
      }
    }
  }
  return lastId;
}

type EventListRow = { id: string; sourceId: string; receivedAt: string };

/**
 * Replay this source's events from the last `durationMs` window, oldest-first,
 * before going live. Pages /api/v1/events (which isn't source-filtered server
 * side, so we filter by sourceId here) and fetches each matching event's body.
 */
export async function backfillSince(
  cfg: Config,
  sourceId: string,
  durationMs: number,
  forward: Forwarder,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const cutoff = Date.now() - durationMs;
  const matches: EventListRow[] = [];
  let cursor: string | null = null;

  outer: do {
    const u = new URL(apiUrl(cfg, "/api/v1/events"));
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetchImpl(u.toString(), { headers: authHeaders(cfg) });
    if (!res.ok) break;
    const body = (await res.json()) as { data: EventListRow[]; nextCursor: string | null };
    for (const row of body.data) {
      // listEvents returns newest-first; once we pass the cutoff we can stop.
      if (new Date(row.receivedAt).getTime() < cutoff) break outer;
      if (row.sourceId === sourceId) matches.push(row);
    }
    cursor = body.nextCursor;
  } while (cursor);

  // Oldest-first so the local app sees them in arrival order.
  matches.reverse();
  for (const row of matches) {
    const res = await fetchImpl(apiUrl(cfg, `/api/v1/events/${row.id}`), {
      headers: authHeaders(cfg),
    });
    if (!res.ok) continue;
    const payload = (await res.json()) as EventPayload;
    const r = await forward(payload);
    if (r.ok) console.log(`↺ ${r.status}  ${r.ms}ms  ${payload.id}`);
    else console.error(`↺✗ ${r.error}  ${payload.id}`);
  }
}

export async function listen(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      forward: { type: "string" },
      since: { type: "string" },
    },
  });
  if (!values.source || !values.forward) {
    console.error("Usage: ody listen --source <slug> --forward <url> [--since <dur>]");
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run `ody login` first.");
    process.exitCode = 1;
    return;
  }

  const forward: Forwarder = (e) => forwardEvent(e, values.forward!);

  if (values.since) {
    const durationMs = parseDuration(values.since);
    if (durationMs === null) {
      console.error(`Invalid --since value: ${values.since} (use e.g. 30s, 5m, 2h, 1d)`);
      process.exitCode = 1;
      return;
    }
    try {
      const sourceId = await resolveSourceId(cfg, values.source);
      console.log(`Replaying the last ${values.since} of "${values.source}"…`);
      await backfillSince(cfg, sourceId, durationMs, forward);
    } catch (err) {
      console.error(`Backfill failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  let lastEventId: string | undefined;
  let backoff = 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const u = new URL(apiUrl(cfg, "/api/v1/listen"));
    u.searchParams.set("source", values.source);
    try {
      const res = await fetch(u.toString(), {
        headers: {
          ...authHeaders(cfg),
          accept: "text/event-stream",
          ...(lastEventId ? { "last-event-id": lastEventId } : {}),
        },
      });
      if (res.status === 401) {
        console.error("Token rejected; re-run `ody login`.");
        process.exitCode = 1;
        return;
      }
      if (res.status === 404) {
        console.error(`Source not found: ${values.source}`);
        process.exitCode = 1;
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`stream failed (HTTP ${res.status})`);
      }
      console.log(`Listening on "${values.source}" → ${values.forward}`);
      backoff = 1000; // reset after a successful connect
      lastEventId = (await consumeStream(res.body, forward)) ?? lastEventId;
    } catch (err) {
      console.error(`Disconnected: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}
