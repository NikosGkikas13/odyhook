import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  composeEmail,
  composeSlackBlocks,
  composeWebhookPayload,
  type AlertContext,
} from "./compose";

const baseCtx: AlertContext = {
  destinationName: "Billing prod",
  destinationId: "dst_abc",
  trigger: "exhausted",
  deliveryId: "del_xyz",
  lastError: "HTTP 500",
};

describe("composeEmail", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://odyhook.dev";
  });
  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("includes destination name in the subject", () => {
    const msg = composeEmail(baseCtx);
    expect(msg.subject).toContain("Billing prod");
  });

  it("includes trigger label and link to the destination page", () => {
    const msg = composeEmail(baseCtx);
    expect(msg.text).toContain("exhausted");
    expect(msg.text).toContain("https://odyhook.dev/destinations/dst_abc");
  });

  it("strips CR/LF from destinationName before putting it in the subject", () => {
    const msg = composeEmail({
      ...baseCtx,
      destinationName: "Bad\r\nSubject: injected",
    });
    expect(msg.subject).not.toMatch(/[\r\n]/);
  });

  it("truncates an oversized lastError", () => {
    const msg = composeEmail({ ...baseCtx, lastError: "x".repeat(1000) });
    expect(msg.text.length).toBeLessThan(2000);
  });
});

describe("composeSlackBlocks", () => {
  it("returns Block Kit JSON with the trigger and destination name", () => {
    const blocks = composeSlackBlocks(baseCtx);
    const txt = JSON.stringify(blocks);
    expect(txt).toContain("Billing prod");
    expect(txt).toContain("exhausted");
  });
});

describe("composeWebhookPayload", () => {
  it("returns a stable JSON shape with all context fields", () => {
    const payload = composeWebhookPayload(baseCtx);
    expect(payload).toMatchObject({
      event: "alert",
      trigger: "exhausted",
      destination: { id: "dst_abc", name: "Billing prod" },
      deliveryId: "del_xyz",
      lastError: "HTTP 500",
    });
    expect(typeof payload.firedAt).toBe("string");
  });
});
