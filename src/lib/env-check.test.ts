import { describe, it, expect } from "vitest";

import { assertProdSecrets } from "./env-check";

const realSecret = "Yt0Hk2bQx9wF7nLp3sV6zJ4cR1mD8aGqU5eW0oI2kY=";

describe("assertProdSecrets", () => {
  it("is a no-op outside production (even with placeholders)", () => {
    expect(() =>
      assertProdSecrets({
        NODE_ENV: "development",
        AUTH_SECRET: "replace-me",
        ENCRYPTION_KEY: "replace-me",
      }),
    ).not.toThrow();
  });

  it("throws in production when a secret is a known placeholder", () => {
    expect(() =>
      assertProdSecrets({
        NODE_ENV: "production",
        AUTH_SECRET: "replace-me-with-a-strong-random-value",
        ENCRYPTION_KEY: realSecret,
      }),
    ).toThrow(/AUTH_SECRET/);
  });

  it("throws in production when a secret is missing or too short", () => {
    expect(() =>
      assertProdSecrets({ NODE_ENV: "production", AUTH_SECRET: realSecret }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      assertProdSecrets({
        NODE_ENV: "production",
        AUTH_SECRET: "short",
        ENCRYPTION_KEY: realSecret,
      }),
    ).toThrow(/AUTH_SECRET/);
  });

  it("passes in production with real-looking secrets", () => {
    expect(() =>
      assertProdSecrets({
        NODE_ENV: "production",
        AUTH_SECRET: realSecret,
        ENCRYPTION_KEY: realSecret,
      }),
    ).not.toThrow();
  });
});
