import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import { loadConfig, type Config } from "../config.js";
import { apiUrl, authHeaders } from "../http.js";
import { filterHeaders, type EventPayload } from "../forward.js";

export type TriggerRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

/** Parse repeated `--header "K: V"` flags into a header map. */
export function parseHeaderFlags(flags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = f.indexOf(":");
    if (i === -1) continue;
    const k = f.slice(0, i).trim();
    const v = f.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Build the POST that delivers a payload to a source's ingest URL. */
export function buildTriggerRequest(
  cfg: Config,
  slug: string,
  body: string,
  headers: Record<string, string>,
): TriggerRequest {
  return {
    url: apiUrl(cfg, `/api/ingest/${slug}`),
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

function readData(spec: string): string {
  if (spec === "-") return readFileSync(0, "utf8"); // stdin
  if (spec.startsWith("@")) return readFileSync(spec.slice(1), "utf8");
  return spec; // inline literal
}

type TriggerValues = { data?: string; replay?: string; generate?: string };

/** Pick the single input mode, or return a usage error if 0 or >1 are given. */
export function resolveTriggerMode(
  v: TriggerValues,
): { mode: "data" | "replay" | "generate" } | { error: string } {
  const chosen = (["data", "replay", "generate"] as const).filter((k) => v[k] != null);
  if (chosen.length === 0) return { error: "Provide one of --data, --replay, or --generate." };
  if (chosen.length > 1) {
    return { error: `--data, --replay, and --generate are mutually exclusive (got ${chosen.join(", ")}).` };
  }
  return { mode: chosen[0] };
}

/** Build the POST to the server-side fixture generator. */
export function buildGenerateRequest(cfg: Config, slug: string, prompt: string): TriggerRequest {
  return {
    url: apiUrl(cfg, "/api/v1/fixtures"),
    method: "POST",
    headers: { ...authHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ source: slug, prompt }),
  };
}

type GenerateResult = { body: string; model: string; groundedOn: number };

/**
 * Generate a fixture via the server, print it, and (unless dryRun) POST it to
 * the source's ingest URL. Exported for testing with an injected fetch.
 */
export async function generateAndSend(
  cfg: Config,
  slug: string,
  prompt: string,
  opts: { dryRun: boolean; headers: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const gen = buildGenerateRequest(cfg, slug, prompt);
  const res = await fetchImpl(gen.url, { method: gen.method, headers: gen.headers, body: gen.body });
  if (res.status === 401) {
    console.error("Token rejected; re-run `ody login`.");
    process.exitCode = 1;
    return;
  }
  if (res.status === 404) {
    console.error(`Source not found: ${slug}`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
    } catch {
      /* non-JSON error body */
    }
    console.error(`Generation failed: ${msg}`);
    process.exitCode = 1;
    return;
  }

  let result: GenerateResult;
  try {
    result = (await res.json()) as GenerateResult;
  } catch {
    console.error("Generation failed: server returned an unreadable response");
    process.exitCode = 1;
    return;
  }
  const grounded = result.groundedOn > 0 ? ` (grounded on ${result.groundedOn} recent event(s))` : "";
  console.log(`Generated fixture${grounded}:`);
  console.log(result.body);

  if (opts.dryRun) return;

  const send = buildTriggerRequest(cfg, slug, result.body, opts.headers);
  const sent = await fetchImpl(send.url, { method: send.method, headers: send.headers, body: send.body });
  const text = await sent.text();
  console.log(`HTTP ${sent.status}  ${text}`);
  if (!sent.ok) process.exitCode = 1;
}

/**
 * Deliver a built request — or, when dryRun, print what would be sent and
 * return without making the call. Applies to every input mode, not just
 * --generate. Exported for testing with an injected fetch.
 */
export async function sendTrigger(
  req: TriggerRequest,
  dryRun: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (dryRun) {
    console.log(`Dry run — not sending. Would ${req.method} ${req.url}:`);
    console.log(req.body);
    return;
  }
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  console.log(`HTTP ${res.status}  ${text}`);
  if (!res.ok) process.exitCode = 1;
}

export async function trigger(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      replay: { type: "string" },
      generate: { type: "string" },
      "dry-run": { type: "boolean" },
      header: { type: "string", multiple: true },
    },
  });
  const slug = positionals[0];
  if (!slug) {
    console.error("Usage: ody trigger <slug> (--data @file.json | --replay <eventId> | --generate \"<description>\") [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run `ody login` first.");
    process.exitCode = 1;
    return;
  }

  const mode = resolveTriggerMode(values);
  if ("error" in mode) {
    console.error(mode.error);
    process.exitCode = 1;
    return;
  }

  const dryRun = Boolean(values["dry-run"]);

  if (mode.mode === "generate") {
    await generateAndSend(cfg, slug, values.generate!, {
      dryRun,
      headers: parseHeaderFlags(values.header ?? []),
    });
    return;
  }

  let req: TriggerRequest;
  if (mode.mode === "replay") {
    const res = await fetch(apiUrl(cfg, `/api/v1/events/${values.replay}`), {
      headers: authHeaders(cfg),
    });
    if (res.status === 404) {
      console.error(`Event not found: ${values.replay}`);
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(`Failed to load event (HTTP ${res.status})`);
      process.exitCode = 1;
      return;
    }
    const evt = (await res.json()) as EventPayload;
    req = {
      url: apiUrl(cfg, `/api/ingest/${slug}`),
      method: "POST",
      headers: filterHeaders(evt.headersJson),
      body: evt.bodyRaw,
    };
    if (!dryRun) {
      console.log(`Replaying ${values.replay} into "${slug}" (a new event will be created; identical bodies may be de-duped)`);
    }
  } else {
    req = buildTriggerRequest(cfg, slug, readData(values.data!), parseHeaderFlags(values.header ?? []));
  }

  await sendTrigger(req, dryRun);
}
