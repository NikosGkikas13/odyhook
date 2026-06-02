import { describe, it, expect } from "vitest";

import {
  readPath,
  evaluateFilter,
  validateFilterAst,
  type FilterAst,
} from "./evaluator";

// A realistic Stripe-shaped sample to anchor the tests.
const sample = {
  id: "evt_1",
  type: "charge.succeeded",
  data: {
    object: {
      amount: 120_000, // cents
      currency: "usd",
      customer: {
        email: "a@b.com",
        address: { country: "DE" },
      },
      metadata: { plan: "pro" },
      tags: ["subscription", "renewal"],
    },
  },
};

describe("readPath", () => {
  it("resolves top-level keys with and without $. prefix", () => {
    expect(readPath(sample, "$.type")).toBe("charge.succeeded");
    expect(readPath(sample, "type")).toBe("charge.succeeded");
    expect(readPath(sample, "$type")).toBe("charge.succeeded");
  });

  it("resolves nested keys", () => {
    expect(readPath(sample, "$.data.object.amount")).toBe(120_000);
    expect(readPath(sample, "$.data.object.customer.address.country")).toBe(
      "DE",
    );
  });

  it("indexes arrays numerically", () => {
    expect(readPath(sample, "$.data.object.tags.0")).toBe("subscription");
    expect(readPath(sample, "$.data.object.tags.1")).toBe("renewal");
  });

  it("returns undefined for missing intermediate keys (no throw)", () => {
    expect(readPath(sample, "$.data.object.nope.deeper")).toBeUndefined();
    expect(readPath(sample, "$.missing")).toBeUndefined();
  });

  it("returns undefined when walking into a primitive", () => {
    expect(readPath(sample, "$.type.nope")).toBeUndefined();
  });

  it("returns the root when the path is empty", () => {
    expect(readPath(sample, "$.")).toBe(sample);
    expect(readPath(sample, "$")).toBe(sample);
  });

  it("does not resolve prototype keys (own-property guard)", () => {
    expect(readPath({}, "$.__proto__")).toBeUndefined();
    expect(readPath({}, "$.constructor")).toBeUndefined();
    expect(readPath({}, "$.toString")).toBeUndefined();
    // But an own property named `constructor` should still resolve.
    expect(readPath({ constructor: 42 }, "$.constructor")).toBe(42);
  });
});

describe("evaluateFilter — leaf operators", () => {
  it("eq: exact match", () => {
    const ast: FilterAst = { eq: ["$.type", "charge.succeeded"] };
    expect(evaluateFilter(ast, sample)).toBe(true);
    expect(
      evaluateFilter({ eq: ["$.type", "other"] }, sample),
    ).toBe(false);
  });

  it("neq: negation", () => {
    expect(
      evaluateFilter({ neq: ["$.type", "charge.failed"] }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ neq: ["$.type", "charge.succeeded"] }, sample),
    ).toBe(false);
  });

  it("gt / gte / lt / lte: numeric comparisons", () => {
    expect(
      evaluateFilter({ gt: ["$.data.object.amount", 100_000] }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ gte: ["$.data.object.amount", 120_000] }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ lt: ["$.data.object.amount", 120_000] }, sample),
    ).toBe(false);
    expect(
      evaluateFilter({ lte: ["$.data.object.amount", 120_000] }, sample),
    ).toBe(true);
  });

  it("numeric comparisons coerce numeric strings", () => {
    expect(
      evaluateFilter({ gt: ["$.s", 5] }, { s: "10" }),
    ).toBe(true);
  });

  it("numeric comparisons reject non-numeric values", () => {
    expect(
      evaluateFilter({ gt: ["$.type", 0] }, sample),
    ).toBe(false);
    expect(
      evaluateFilter({ gt: ["$.missing", 0] }, sample),
    ).toBe(false);
  });

  it("in: membership", () => {
    expect(
      evaluateFilter(
        { in: ["$.data.object.customer.address.country", ["DE", "FR", "IT"]] },
        sample,
      ),
    ).toBe(true);
    expect(
      evaluateFilter(
        { in: ["$.data.object.customer.address.country", ["US", "CA"]] },
        sample,
      ),
    ).toBe(false);
  });

  it("contains: case-insensitive substring on strings", () => {
    expect(
      evaluateFilter({ contains: ["$.type", "SUCCEED"] }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ contains: ["$.type", "refund"] }, sample),
    ).toBe(false);
  });

  it("contains: returns false on non-strings (fail-closed)", () => {
    expect(
      evaluateFilter({ contains: ["$.data.object.amount", "120"] }, sample),
    ).toBe(false);
  });

  it("startsWith: case-insensitive prefix on strings", () => {
    expect(evaluateFilter({ startsWith: ["$.type", "CHARGE."] }, sample)).toBe(true);
    expect(evaluateFilter({ startsWith: ["$.type", "refund"] }, sample)).toBe(false);
  });

  it("endsWith: case-insensitive suffix on strings", () => {
    expect(
      evaluateFilter({ endsWith: ["$.data.object.customer.email", "@B.COM"] }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ endsWith: ["$.data.object.customer.email", "@gmail.com"] }, sample),
    ).toBe(false);
  });

  it("startsWith/endsWith: return false on non-strings (fail-closed)", () => {
    expect(evaluateFilter({ startsWith: ["$.data.object.amount", "12"] }, sample)).toBe(false);
    expect(evaluateFilter({ endsWith: ["$.data.object.amount", "00"] }, sample)).toBe(false);
  });

  it("exists: truthy when the path resolves to anything but undefined", () => {
    expect(
      evaluateFilter({ exists: "$.data.object.customer.email" }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ exists: "$.data.object.nope" }, sample),
    ).toBe(false);
    // null counts as "exists" because the field was explicitly present.
    expect(evaluateFilter({ exists: "$.x" }, { x: null })).toBe(true);
  });
});

describe("evaluateFilter — boolean composition", () => {
  it("and: all children must pass", () => {
    const ast: FilterAst = {
      and: [
        { eq: ["$.type", "charge.succeeded"] },
        { gt: ["$.data.object.amount", 100_000] },
        { in: ["$.data.object.customer.address.country", ["DE", "FR"]] },
      ],
    };
    expect(evaluateFilter(ast, sample)).toBe(true);
  });

  it("and: short-circuits on the first false child", () => {
    const ast: FilterAst = {
      and: [
        { eq: ["$.type", "charge.refunded"] },
        { gt: ["$.data.object.amount", 100_000] },
      ],
    };
    expect(evaluateFilter(ast, sample)).toBe(false);
  });

  it("or: at least one child must pass", () => {
    const ast: FilterAst = {
      or: [
        { eq: ["$.type", "charge.refunded"] },
        { eq: ["$.type", "charge.succeeded"] },
      ],
    };
    expect(evaluateFilter(ast, sample)).toBe(true);
  });

  it("not: inverts", () => {
    expect(
      evaluateFilter({ not: { eq: ["$.type", "charge.refunded"] } }, sample),
    ).toBe(true);
  });

  it("deeply nested composition", () => {
    const ast: FilterAst = {
      and: [
        { eq: ["$.type", "charge.succeeded"] },
        {
          or: [
            { gt: ["$.data.object.amount", 1_000_000] },
            {
              and: [
                { eq: ["$.data.object.currency", "usd"] },
                {
                  in: [
                    "$.data.object.customer.address.country",
                    ["DE", "FR", "IT"],
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(evaluateFilter(ast, sample)).toBe(true);
  });
});

describe("evaluateFilter — fail-closed behaviour", () => {
  it("returns false for an invalid/unknown node shape", () => {
    // @ts-expect-error intentionally invalid
    expect(evaluateFilter({ weird: ["$.a", 1] }, sample)).toBe(false);
  });

  it("returns false for null/undefined AST", () => {
    // @ts-expect-error intentionally invalid
    expect(evaluateFilter(null, sample)).toBe(false);
    // @ts-expect-error intentionally invalid
    expect(evaluateFilter(undefined, sample)).toBe(false);
  });
});

describe("validateFilterAst", () => {
  it("accepts a well-formed AST", () => {
    const ast = validateFilterAst({
      and: [
        { eq: ["$.type", "x"] },
        { gt: ["$.amount", 100] },
        { in: ["$.country", ["DE", "FR"]] },
        { exists: "$.email" },
        { not: { contains: ["$.type", "refund"] } },
      ],
    });
    expect(ast).toBeTypeOf("object");
  });

  it("rejects non-objects", () => {
    expect(() => validateFilterAst(null)).toThrow();
    expect(() => validateFilterAst(42)).toThrow();
    expect(() => validateFilterAst([])).toThrow();
  });

  it("rejects nodes with more than one key", () => {
    expect(() =>
      validateFilterAst({ eq: ["$.a", 1], gt: ["$.b", 2] }),
    ).toThrow(/exactly one key/);
  });

  it("rejects unknown node types", () => {
    expect(() => validateFilterAst({ weird: 1 })).toThrow(/unknown/);
  });

  it("rejects empty and/or arrays", () => {
    expect(() => validateFilterAst({ and: [] })).toThrow(/non-empty/);
    expect(() => validateFilterAst({ or: [] })).toThrow(/non-empty/);
  });

  it("rejects wrong-arity comparison nodes", () => {
    expect(() => validateFilterAst({ eq: ["$.a"] })).toThrow(/2-element/);
    expect(() =>
      validateFilterAst({ eq: ["$.a", 1, 2] }),
    ).toThrow(/2-element/);
  });

  it("rejects non-string paths", () => {
    expect(() => validateFilterAst({ eq: [123, "x"] })).toThrow(/string/);
  });

  it("rejects non-numeric literals on numeric operators", () => {
    expect(() => validateFilterAst({ gt: ["$.a", "big"] })).toThrow(
      /number/,
    );
  });

  it("rejects non-array literals on in", () => {
    expect(() => validateFilterAst({ in: ["$.a", "x"] })).toThrow(/array/);
  });

  it("rejects non-string literals on contains", () => {
    expect(() => validateFilterAst({ contains: ["$.a", 123] })).toThrow(
      /string/,
    );
  });

  it("accepts startsWith/endsWith with string literals", () => {
    expect(validateFilterAst({ startsWith: ["$.a", "x"] })).toBeTypeOf("object");
    expect(validateFilterAst({ endsWith: ["$.a", "y"] })).toBeTypeOf("object");
  });

  it("rejects non-string literals on startsWith/endsWith", () => {
    expect(() => validateFilterAst({ startsWith: ["$.a", 1] })).toThrow(/string/);
    expect(() => validateFilterAst({ endsWith: ["$.a", 1] })).toThrow(/string/);
  });

  it("recursively validates children of and/or/not", () => {
    expect(() =>
      validateFilterAst({ and: [{ eq: ["$.a", 1] }, { weird: 1 }] }),
    ).toThrow(/unknown/);
    expect(() => validateFilterAst({ not: { weird: 1 } })).toThrow(/unknown/);
  });
});
