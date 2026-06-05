import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DNS resolution so the async path (resolveSafe / assertSafeUrl) is
// deterministic and offline. The sync tests below don't touch DNS.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({ promises: { lookup: lookupMock } }));

import {
  isPrivateIp,
  parseSafeUrl,
  resolveSafe,
  assertSafeUrl,
  SsrfError,
} from "./ssrf";

describe("isPrivateIp", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "172.16.5.6",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("rejects private IPv4 %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "151.101.1.1", "172.32.0.1", "100.128.0.1"])(
    "allows public IPv4 %s",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  it.each([
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ])("rejects private IPv6 %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows public IPv6 %s",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  it("rejects unparseable input", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("999.999.999.999")).toBe(true);
  });
});

describe("parseSafeUrl", () => {
  it("accepts a normal https URL", () => {
    const url = parseSafeUrl("https://api.example.com/hook");
    expect(url.hostname).toBe("api.example.com");
  });

  it("accepts http (some users have HTTP-only sinks)", () => {
    expect(() => parseSafeUrl("http://example.com/")).not.toThrow();
  });

  it.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "gopher://example.com/",
    "javascript:alert(1)",
  ])("rejects scheme %s", (raw) => {
    expect(() => parseSafeUrl(raw)).toThrow(SsrfError);
  });

  it("rejects credentials in URL", () => {
    expect(() => parseSafeUrl("https://user:pw@example.com/")).toThrow(
      SsrfError,
    );
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fe80::1]/",
  ])("rejects private IP literal %s", (raw) => {
    expect(() => parseSafeUrl(raw)).toThrow(SsrfError);
  });

  it("does not resolve DNS — hostnames pass parseSafeUrl", () => {
    // localhost would be caught at the DNS step in assertSafeUrl, but the
    // sync parser only inspects literal IPs.
    expect(() => parseSafeUrl("http://localhost/")).not.toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => parseSafeUrl("not a url")).toThrow(SsrfError);
  });
});

describe("resolveSafe", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("returns a literal public IP without consulting DNS", async () => {
    const { url, ips } = await resolveSafe("http://93.184.216.34/hook");
    expect(url.hostname).toBe("93.184.216.34");
    expect(ips).toEqual(["93.184.216.34"]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a literal private IP without consulting DNS", async () => {
    await expect(resolveSafe("http://169.254.169.254/")).rejects.toThrow(
      SsrfError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("resolves a hostname and returns every public address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const { url, ips } = await resolveSafe("https://api.example.com/hook");
    expect(url.hostname).toBe("api.example.com");
    expect(ips).toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);
  });

  it("rejects when ANY resolved address is private (rebinding/multi-record)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(resolveSafe("https://rebind.example.com/")).rejects.toThrow(
      SsrfError,
    );
  });

  it("rejects when DNS returns no addresses", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(resolveSafe("https://void.example.com/")).rejects.toThrow(
      SsrfError,
    );
  });

  it("rejects when DNS lookup itself fails", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolveSafe("https://nope.example.com/")).rejects.toThrow(
      SsrfError,
    );
  });

  it("still rejects disallowed schemes (delegates to parseSafeUrl)", async () => {
    await expect(resolveSafe("file:///etc/passwd")).rejects.toThrow(SsrfError);
  });
});

describe("assertSafeUrl (built on resolveSafe)", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("returns the parsed URL for a public host", async () => {
    lookupMock.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    const url = await assertSafeUrl("https://ok.example.com/path");
    expect(url.hostname).toBe("ok.example.com");
  });

  it("throws SsrfError for a host that resolves private", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.9", family: 4 }]);
    await expect(assertSafeUrl("https://evil.example.com/")).rejects.toThrow(
      SsrfError,
    );
  });
});
