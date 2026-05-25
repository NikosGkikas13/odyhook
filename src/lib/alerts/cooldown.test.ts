import "dotenv/config";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getConnection } from "../queue";
import { tryClaimCooldown, cooldownKey } from "./cooldown";

const redis = getConnection();

async function clear(destId: string, trigger: "exhausted" | "failureRate" | "firstFailure") {
  await redis.del(cooldownKey(destId, trigger));
}

describe("tryClaimCooldown", () => {
  const destId = `cool-${Date.now()}`;

  beforeEach(async () => {
    await clear(destId, "exhausted");
  });

  afterAll(async () => {
    await clear(destId, "exhausted");
  });

  it("returns true the first time and false the second time within TTL", async () => {
    const first = await tryClaimCooldown(destId, "exhausted", 60);
    const second = await tryClaimCooldown(destId, "exhausted", 60);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("allows a new claim after the TTL expires", async () => {
    // 1s TTL is short enough to wait through in a test.
    await tryClaimCooldown(destId, "exhausted", 1);
    await new Promise((r) => setTimeout(r, 1100));
    const after = await tryClaimCooldown(destId, "exhausted", 60);
    expect(after).toBe(true);
  });

  it("scopes claims independently per trigger", async () => {
    await tryClaimCooldown(destId, "exhausted", 60);
    const otherTrigger = await tryClaimCooldown(destId, "failureRate", 60);
    expect(otherTrigger).toBe(true);
    await clear(destId, "failureRate");
  });
});

describe("cooldownKey", () => {
  it("produces a stable, namespaced key", () => {
    expect(cooldownKey("dst_abc", "exhausted")).toBe(
      "alert:cooldown:dst_abc:exhausted",
    );
  });
});
