import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getFailureThreshold } from "./circuit-breaker";

describe("getFailureThreshold", () => {
  const original = process.env.DESTINATION_FAILURE_THRESHOLD;
  afterEach(() => {
    if (original === undefined) delete process.env.DESTINATION_FAILURE_THRESHOLD;
    else process.env.DESTINATION_FAILURE_THRESHOLD = original;
  });

  it("defaults to 5 when env var is unset", () => {
    delete process.env.DESTINATION_FAILURE_THRESHOLD;
    expect(getFailureThreshold()).toBe(5);
  });

  it("reads a positive integer from the env var", () => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "12";
    expect(getFailureThreshold()).toBe(12);
  });

  it("falls back to the default if the env var is non-numeric", () => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "abc";
    expect(getFailureThreshold()).toBe(5);
  });

  it("falls back to the default if the env var is <= 0", () => {
    process.env.DESTINATION_FAILURE_THRESHOLD = "0";
    expect(getFailureThreshold()).toBe(5);
  });
});
