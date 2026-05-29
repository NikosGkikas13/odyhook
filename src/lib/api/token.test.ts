import { describe, it, expect } from "vitest";
import { generateToken, hashToken, parseBearer } from "./token";

describe("token primitives", () => {
  it("generates an ody_ token whose hash matches hashToken(raw)", () => {
    const t = generateToken();
    expect(t.raw.startsWith("ody_")).toBe(true);
    expect(t.prefix).toBe(t.raw.slice(0, 8));
    expect(t.hash).toBe(hashToken(t.raw));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    expect(generateToken().raw).not.toBe(generateToken().raw);
  });

  it("parses a Bearer header and rejects junk", () => {
    expect(parseBearer("Bearer ody_abc")).toBe("ody_abc");
    expect(parseBearer("bearer ody_abc")).toBe("ody_abc"); // case-insensitive scheme
    expect(parseBearer("Token ody_abc")).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
  });
});
