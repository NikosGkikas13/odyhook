import { describe, it, expect } from "vitest";
import { apiError, rateLimited, parsePage } from "./respond";

describe("apiError", () => {
  it("maps codes to statuses and nests under error", async () => {
    const res = apiError("not_found", "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "nope" } });
  });

  it("includes details when given", async () => {
    const res = apiError("validation_error", "bad", { fields: ["name"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "validation_error", message: "bad", details: { fields: ["name"] } },
    });
  });
});

describe("rateLimited", () => {
  it("is 429 with Retry-After", () => {
    const res = rateLimited(7);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
  });
});

describe("parsePage", () => {
  it("defaults limit to 25 and cursor to null", () => {
    expect(parsePage(new URL("https://x/api/v1/events"))).toEqual({ limit: 25, cursor: null });
  });
  it("clamps limit to [1,100] and reads cursor", () => {
    expect(parsePage(new URL("https://x/y?limit=500&cursor=abc")).limit).toBe(100);
    expect(parsePage(new URL("https://x/y?limit=0")).limit).toBe(1);
    expect(parsePage(new URL("https://x/y?limit=10&cursor=abc")).cursor).toBe("abc");
  });
  it("falls back to 25 on non-numeric limit", () => {
    expect(parsePage(new URL("https://x/y?limit=abc")).limit).toBe(25);
  });
});
