import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

import authConfig from "./auth.config";

const authorized = authConfig.callbacks!.authorized!;
const session = (id: string) => ({ user: { id } }) as unknown as Session;
const reqFor = (path: string) => new NextRequest(`https://odyhook.dev${path}`);

describe("auth.config authorized callback", () => {
  it("allows an authenticated request", async () => {
    const r = await authorized({
      auth: session("u1"),
      request: reqFor("/api/events/bulk-replay"),
    });
    expect(r).toBe(true);
  });

  it("returns a 401 JSON response for an unauthenticated API route", async () => {
    const r = await authorized({
      auth: null,
      request: reqFor("/api/events/bulk-replay"),
    });
    expect(r).toBeInstanceOf(Response);
    const res = r as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // A 401 must not redirect — no Location header (would loop / break the API contract).
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects (returns false) for an unauthenticated dashboard page", async () => {
    const r = await authorized({
      auth: null,
      request: reqFor("/events"),
    });
    expect(r).toBe(false);
  });
});
