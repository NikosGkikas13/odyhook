import { describe, it, expect } from "vitest";
import {
  shouldFireExhausted,
  shouldFireFailureRate,
  shouldFireFirstFailure,
  type DeliveryHistoryRow,
} from "./triggers";

const ok = (id: string): DeliveryHistoryRow => ({ id, status: "delivered" });
const fail = (id: string): DeliveryHistoryRow => ({ id, status: "exhausted" });

describe("shouldFireExhausted", () => {
  it("fires when the trigger is enabled and the outcome is exhausted", () => {
    expect(
      shouldFireExhausted(
        { enabled: true },
        { status: "exhausted" },
      ),
    ).toBe(true);
  });

  it("does not fire when the trigger is disabled", () => {
    expect(
      shouldFireExhausted(undefined, { status: "exhausted" }),
    ).toBe(false);
    expect(
      shouldFireExhausted({ enabled: false }, { status: "exhausted" }),
    ).toBe(false);
  });

  it("does not fire when the outcome is delivered", () => {
    expect(
      shouldFireExhausted({ enabled: true }, { status: "delivered" }),
    ).toBe(false);
  });

  it("does not fire on intermediate 'failed' status (only terminal exhausted)", () => {
    expect(
      shouldFireExhausted({ enabled: true }, { status: "failed" }),
    ).toBe(false);
  });
});

describe("shouldFireFailureRate", () => {
  const cfg = { enabled: true, ratePct: 50, windowCount: 4 } as const;

  it("does not fire when disabled", () => {
    expect(
      shouldFireFailureRate(undefined, [fail("a"), fail("b")]),
    ).toBe(false);
  });

  it("does not fire when the window has fewer than windowCount rows", () => {
    expect(shouldFireFailureRate(cfg, [fail("a")])).toBe(false);
    expect(shouldFireFailureRate(cfg, [fail("a"), fail("b"), fail("c")])).toBe(
      false,
    );
  });

  it("fires when failures meet the threshold", () => {
    expect(
      shouldFireFailureRate(cfg, [fail("a"), fail("b"), ok("c"), ok("d")]),
    ).toBe(true);
  });

  it("does not fire when below the threshold", () => {
    expect(
      shouldFireFailureRate(cfg, [fail("a"), ok("b"), ok("c"), ok("d")]),
    ).toBe(false);
  });

  it("counts both 'failed' and 'exhausted' as failures", () => {
    const mixed: DeliveryHistoryRow[] = [
      { id: "1", status: "failed" },
      { id: "2", status: "exhausted" },
      { id: "3", status: "delivered" },
      { id: "4", status: "delivered" },
    ];
    expect(shouldFireFailureRate(cfg, mixed)).toBe(true);
  });
});

describe("shouldFireFirstFailure", () => {
  const cfg = { enabled: true, afterSuccessCount: 3 } as const;

  it("does not fire when disabled", () => {
    expect(
      shouldFireFirstFailure(
        undefined,
        { status: "exhausted" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(false);
  });

  it("does not fire when the current outcome is delivered", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "delivered" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(false);
  });

  it("fires when the current outcome is exhausted and prior N are all delivered", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "exhausted" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(true);
  });

  it("fires when the current outcome is failed and prior N are all delivered", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "failed" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(true);
  });

  it("does not fire when fewer than afterSuccessCount priors exist", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "exhausted" },
        [ok("a"), ok("b")],
      ),
    ).toBe(false);
  });

  it("does not fire when any prior is a failure", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "exhausted" },
        [ok("a"), fail("b"), ok("c")],
      ),
    ).toBe(false);
  });
});
