import { describe, it, expect } from "vitest";

import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
  it("strips the request body, cookies, and query string", () => {
    const out = scrubSentryEvent({
      request: {
        data: { secret: "payload" },
        cookies: { session: "abc" },
        query_string: "token=xyz",
        headers: { "content-type": "application/json" },
      },
    });
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    // Benign headers are preserved.
    expect(out.request?.headers?.["content-type"]).toBe("application/json");
  });

  it("removes sensitive headers (auth, cookie, signatures)", () => {
    const out = scrubSentryEvent({
      request: {
        headers: {
          authorization: "Bearer ody_secret",
          Cookie: "session=abc",
          "stripe-signature": "t=1,v1=deadbeef",
          "x-hub-signature-256": "sha256=...",
          "user-agent": "curl",
        },
      },
    });
    const h = out.request?.headers ?? {};
    expect(h.authorization).toBeUndefined();
    expect(h.Cookie).toBeUndefined();
    expect(h["stripe-signature"]).toBeUndefined();
    expect(h["x-hub-signature-256"]).toBeUndefined();
    expect(h["user-agent"]).toBe("curl"); // benign kept
  });

  it("is a no-op when there is no request", () => {
    expect(() => scrubSentryEvent({})).not.toThrow();
    expect(scrubSentryEvent({ extra: 1 } as never)).toEqual({ extra: 1 });
  });
});
