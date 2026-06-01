import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { handleMessage, PROTOCOL_VERSION } from "./server";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
async function newUser() {
  return prisma.user.create({ data: { email: `${uniq("mcps")}@test.local` } });
}

describe("mcp handleMessage", () => {
  it("responds to initialize with protocol + serverInfo", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res?.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "odyhook" } });
  });

  it("returns null for the initialized notification", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  it("lists tools with JSON Schemas", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = res?.result as { tools: { name: string; inputSchema: { type?: string } }[] };
    const t = list.tools.find((x) => x.name === "get_source");
    expect(t?.inputSchema.type).toBe("object");
  });

  it("calls a tool and returns scoped text content", async () => {
    const u = await newUser();
    const source = await prisma.source.create({ data: { userId: u.id, name: "s", slug: uniq("mcps-s") } });
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sources", arguments: { limit: 100 } } });
    const result = res?.result as { content: { text: string }[] };
    expect(result.content[0].text).toContain(source.id);
  });

  it("maps unknown method to -32601", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 4, method: "tools/nope" });
    expect(res?.error?.code).toBe(-32601);
  });

  it("returns invalid-params (-32602) for bad tool arguments", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_source", arguments: {} } });
    expect(res?.error?.code).toBe(-32602);
  });

  it("returns an isError result for an unknown tool name", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
    const result = res?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("responds with the server's protocol version even if the client requests another", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 8, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("returns an isError result (not a JSON-RPC error) when a tool hits a domain not-found", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_source", arguments: { id: "does-not-exist" } } });
    expect(res?.error).toBeUndefined();
    const result = res?.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});
