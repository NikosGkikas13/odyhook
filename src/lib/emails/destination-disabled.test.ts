import { describe, it, expect } from "vitest";

import { composeDestinationDisabledEmail } from "./destination-disabled";

describe("composeDestinationDisabledEmail", () => {
  it("returns subject, text, and a destinations URL pointing at APP_URL", () => {
    const original = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://odyhook.dev";
    const msg = composeDestinationDisabledEmail({
      destinationName: "Billing (prod)",
      reason: "HTTP 502",
      consecutiveFailures: 5,
    });
    expect(msg.subject).toBe(
      "Odyhook: destination \"Billing (prod)\" auto-disabled",
    );
    expect(msg.text).toContain("Billing (prod)");
    expect(msg.text).toContain("HTTP 502");
    expect(msg.text).toContain("5 consecutive");
    expect(msg.text).toContain("Resume here: https://odyhook.dev/destinations");
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("falls back to a relative path when APP_URL is unset", () => {
    const original = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const msg = composeDestinationDisabledEmail({
      destinationName: "X",
      reason: "timeout",
      consecutiveFailures: 5,
    });
    expect(msg.text).toContain("Resume here: /destinations");
    if (original !== undefined) process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("truncates very long reasons so emails stay readable", () => {
    const long = "x".repeat(2000);
    const msg = composeDestinationDisabledEmail({
      destinationName: "X",
      reason: long,
      consecutiveFailures: 5,
    });
    expect(msg.text.length).toBeLessThan(1500);
  });

  it("strips newlines from destinationName to prevent subject header injection", () => {
    const msg = composeDestinationDisabledEmail({
      destinationName: "Evil\nBcc: attacker@example.com",
      reason: "test",
      consecutiveFailures: 5,
    });
    expect(msg.subject).not.toContain("\n");
    expect(msg.subject).not.toContain("\r");
    expect(msg.subject).toBe('Odyhook: destination "EvilBcc: attacker@example.com" auto-disabled');
  });
});
