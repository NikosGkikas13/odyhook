import { parseArgs } from "node:util";

import { loadConfig } from "../config.js";
import { apiUrl, authHeaders } from "../http.js";
import { SSEParser } from "../sse.js";
import { forwardEvent, type EventPayload, type ForwardResult } from "../forward.js";

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
