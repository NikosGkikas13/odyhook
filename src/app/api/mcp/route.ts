import { authenticateApiToken } from "@/lib/api/authenticate";
import { checkApiRateLimit } from "@/lib/ratelimit";
import { readJsonLimited, BodyTooLargeError } from "@/lib/api/body";
import { handleMessage, type JsonRpcRequest, type JsonRpcResponse } from "@/lib/mcp/server";

export const runtime = "nodejs";

function json(payload: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateApiToken(req);
  if (!auth) return json({ error: "unauthorized" }, 401);

  try {
    const rl = await checkApiRateLimit(auth.tokenId);
    if (!rl.allowed) {
      return json({ error: "rate limited" }, 429, {
        "Retry-After": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))),
      });
    }
  } catch (err) {
    // Fail open on Redis errors, matching ingest/api behavior.
    console.error("[mcp] rate limiter error (failing open):", err);
  }

  let body: unknown;
  try {
    body = await readJsonLimited(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } },
        413,
      );
    }
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses: JsonRpcResponse[] = [];
  for (const m of messages) {
    const res = await handleMessage(auth.userId, m as JsonRpcRequest);
    if (res) responses.push(res);
  }

  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0], 200);
}
