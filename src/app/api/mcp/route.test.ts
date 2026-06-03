import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const user = await prisma.user.create({ data: { email: `${uniq("mcpr")}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("mcpr-s") } });
  return { raw: t.raw, user, source };
}

function rpc(raw: string | null, msg: unknown): Request {
  return new Request("https://x/api/mcp", {
    method: "POST",
    headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
}

describe("/api/mcp", () => {
  it("401s without a token", async () => {
    const res = await POST(rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(401);
  });

  it("initializes with a valid token", async () => {
    const { raw } = await setup();
    const res = await POST(rpc(raw, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("odyhook");
  });

  it("calls a tool scoped to the token's user", async () => {
    const { raw, source } = await setup();
    const res = await POST(rpc(raw, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sources", arguments: { limit: 100 } } }));
    const body = await res.json();
    expect(body.result.content[0].text).toContain(source.id);
  });

  it("does not expose another user's source", async () => {
    const a = await setup();
    const b = await setup();
    const res = await POST(rpc(b.raw, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_source", arguments: { id: a.source.id } } }));
    const body = await res.json();
    expect(body.result.isError).toBe(true);
  });

  it("returns 202 for a notification", async () => {
    const { raw } = await setup();
    const res = await POST(rpc(raw, { jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
  });

  it("returns 400 with a JSON-RPC parse error on invalid JSON", async () => {
    const { raw } = await setup();
    const req = new Request("https://x/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
      body: "not json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("413s on an oversize body", async () => {
    const { raw } = await setup();
    const big = {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { s: "x".repeat(300 * 1024) },
    };
    const res = await POST(rpc(raw, big));
    expect(res.status).toBe(413);
  });
});
