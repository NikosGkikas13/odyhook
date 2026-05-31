import { describe, it, expect } from "vitest";
import { resolveSourceId } from "./http";
import type { Config } from "./config";

const cfg: Config = { host: "https://odyhook.dev", token: "ody_abc" };

describe("resolveSourceId", () => {
  it("maps a slug to its id via /api/v1/sources", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toContain("/api/v1/sources");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer ody_abc");
      return new Response(
        JSON.stringify({ data: [{ id: "src_1", slug: "gh-prod" }], nextCursor: null }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    expect(await resolveSourceId(cfg, "gh-prod", fakeFetch)).toBe("src_1");
  });

  it("throws when the slug is not found", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: [], nextCursor: null }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(resolveSourceId(cfg, "missing", fakeFetch)).rejects.toThrow(/not found/i);
  });
});
