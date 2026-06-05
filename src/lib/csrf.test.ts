import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { isAllowedOrigin } from "./csrf";

let savedAuth: string | undefined;
let savedApp: string | undefined;
beforeEach(() => {
  savedAuth = process.env.AUTH_URL;
  savedApp = process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.AUTH_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});
afterEach(() => {
  if (savedAuth === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = savedAuth;
  if (savedApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedApp;
});

function req(headers: Record<string, string>, url = "https://app.example/api/x"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("isAllowedOrigin", () => {
  it("allows an Origin matching the request's own URL origin (same-origin)", () => {
    expect(isAllowedOrigin(req({ origin: "https://app.example" }))).toBe(true);
  });

  it("allows an Origin matching a configured AUTH_URL even behind a proxy host", () => {
    process.env.AUTH_URL = "https://odyhook.dev";
    expect(
      isAllowedOrigin(req({ origin: "https://odyhook.dev" }, "http://web:3000/api/x")),
    ).toBe(true);
  });

  it("rejects a cross-site Origin", () => {
    expect(isAllowedOrigin(req({ origin: "https://evil.example" }))).toBe(false);
  });

  it("rejects when both Origin and Referer are absent", () => {
    expect(isAllowedOrigin(req({}))).toBe(false);
  });

  it("falls back to the Referer's origin when Origin is absent", () => {
    expect(isAllowedOrigin(req({ referer: "https://app.example/dashboard" }))).toBe(true);
    expect(isAllowedOrigin(req({ referer: "https://evil.example/x" }))).toBe(false);
  });
});
