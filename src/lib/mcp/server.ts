import { z } from "zod";

import { tools, findTool } from "./tools";
import { RouteConflictError } from "@/lib/services/routes";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "odyhook", version: "1.0.0" };

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: string } & Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

class McpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

function toolText(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function mapDomainError(err: unknown): ToolResult {
  if (err instanceof RouteConflictError) return toolError(err.message);
  if (err instanceof Error) {
    if (/not found/i.test(err.message)) return toolError(err.message);
    if (/^invalid filter AST/i.test(err.message)) return toolError(err.message);
    if (/^Destination URL rejected:/.test(err.message) || /^Invalid header/.test(err.message)) return toolError(err.message);
    if (/No Anthropic API key configured/i.test(err.message)) return toolError(err.message);
  }
  console.error("[mcp] tool error:", err); // Sentry auto-captures
  return toolError("internal error");
}

export function listToolSchemas() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema),
  }));
}

export async function runTool(userId: string, name: unknown, args: unknown): Promise<ToolResult> {
  // Protocol-level failures (malformed/invalid args) throw McpError → JSON-RPC error.
  // Domain failures (not found, conflict, ...) return { isError: true } tool results so the agent can recover.
  if (typeof name !== "string") throw new McpError(-32602, "tools/call requires a string 'name'");
  const tool = findTool(name);
  if (!tool) return toolError(`unknown tool: ${name}`);

  let parsed: unknown;
  try {
    parsed = tool.inputSchema.parse(args ?? {});
  } catch (e) {
    if (e instanceof z.ZodError) throw new McpError(-32602, "invalid tool arguments", e.issues);
    throw e;
  }

  try {
    return toolText(await tool.handler(userId, parsed as never));
  } catch (e) {
    return mapDomainError(e);
  }
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Handle one JSON-RPC message. Returns null for notifications (no response body). */
export async function handleMessage(userId: string, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg ?? ({} as JsonRpcRequest);
  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: listToolSchemas() });
      case "tools/call":
        return ok(id, await runTool(userId, params?.name, params?.arguments));
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof McpError) return fail(id, e.code, e.message, e.data);
    console.error("[mcp] unhandled:", e);
    return fail(id, -32603, "internal error");
  }
}
