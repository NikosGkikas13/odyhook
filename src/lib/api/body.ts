// Bounded JSON body reader for authenticated Route Handlers.
//
// Next.js App Router Route Handlers impose no implicit body-size limit (unlike
// Server Actions, which default to serverActions.bodySizeLimit). A bare
// `await req.json()` therefore buffers an arbitrarily large body into memory
// before any validation, letting one authenticated caller OOM the shared web
// process. This mirrors the ingest endpoint's streaming cap for every other
// JSON handler.
//
// Defends in two layers:
//   1. Content-Length pre-check — reject an honestly-declared oversize body
//      before reading a byte.
//   2. Capped streaming read — for a missing/lying Content-Length (chunked
//      upload), abort the stream the moment the cap is exceeded.

export const DEFAULT_MAX_JSON_BYTES = 256 * 1024; // 256 KiB

/** Thrown when the body exceeds the cap. Callers map this to HTTP 413. */
export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Thrown when the body is missing or not valid JSON. Callers map to 400. */
export class InvalidJsonError extends Error {
  constructor() {
    super("invalid JSON body");
    this.name = "InvalidJsonError";
  }
}

function defaultLimit(): number {
  const raw = process.env.API_MAX_JSON_BYTES;
  if (!raw) return DEFAULT_MAX_JSON_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_JSON_BYTES;
}

/**
 * Read and JSON-parse a request body, rejecting anything larger than `limit`
 * bytes. Throws `BodyTooLargeError` (→ 413) when the cap is exceeded and
 * `InvalidJsonError` (→ 400) for a missing/malformed body.
 */
export async function readJsonLimited(
  req: Request,
  limit: number = defaultLimit(),
): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    throw new BodyTooLargeError(limit);
  }

  if (!req.body) throw new InvalidJsonError();

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
        // Stop the upload instead of buffering the rest.
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}
