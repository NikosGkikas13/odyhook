import "dotenv/config"; // @/lib/quota → @/lib/prisma instantiates Prisma at import
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { QuotaExceededError } from "@/lib/quota";
import { toFormError } from "./form-error";

describe("toFormError", () => {
  it("maps a ZodError to its first issue message (the empty-secret case)", () => {
    const err = new z.ZodError([
      {
        code: "custom",
        path: ["signingSecret"],
        message: "signing secret is required when verifyStyle is set",
      },
    ]);
    expect(toFormError(err)).toBe("signing secret is required when verifyStyle is set");
  });

  it("maps a QuotaExceededError to its message", () => {
    expect(toFormError(new QuotaExceededError("sources", 100))).toBe(
      "account limit reached: at most 100 sources per account",
    );
  });

  it("returns null for unexpected errors so the action rethrows to the error boundary", () => {
    expect(toFormError(new Error("boom"))).toBeNull();
    expect(toFormError("not even an error")).toBeNull();
  });
});
