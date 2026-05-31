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

export async function trigger(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      replay: { type: "string" },
      header: { type: "string", multiple: true },
    },
  });
  const slug = positionals[0];
  if (!slug) {
    console.error("Usage: ody trigger <slug> (--data @file.json | --replay <eventId>)");
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run `ody login` first.");
    process.exitCode = 1;
    return;
  }

  let req: TriggerRequest;
  if (values.replay) {
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
    console.log(`Replaying ${values.replay} into "${slug}" (a new event will be created; identical bodies may be de-duped)`);
  } else if (values.data) {
    req = buildTriggerRequest(cfg, slug, readData(values.data), parseHeaderFlags(values.header ?? []));
  } else {
    console.error("Provide either --data <@file|-> or --replay <eventId>.");
    process.exitCode = 1;
    return;
  }

  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  console.log(`HTTP ${res.status}  ${text}`);
  if (!res.ok) process.exitCode = 1;
}
