import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { safeFetch, pinnedLookup } from "./safe-fetch";
import { SsrfError } from "./ssrf";

// Spin up a throwaway loopback HTTP server. Tests inject a resolver so the real
// pin-and-fetch path runs against this server (production resolveSafe would
// correctly refuse 127.0.0.1 — the injection is the legitimate test seam).
type Started = {
  port: number;
  hits: { method: string; url: string; host?: string; body: string }[];
  close: () => Promise<void>;
};

const servers: Started[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Started> {
  const hits: Started["hits"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        host: req.headers.host,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const started: Started = {
    port,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
  servers.push(started);
  return started;
}

// A resolver that pins to loopback but reports an arbitrary hostname, so the
// test proves safeFetch connects to the pinned IP rather than the hostname.
function pinTo(ip: string, urlStr: string) {
  return async () => ({ url: new URL(urlStr), ips: [ip] });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});

describe("pinnedLookup", () => {
  it("returns an IPv4 address with family 4 (non-all callback form)", () => {
    const cb = viFnCapture();
    pinnedLookup("203.0.113.7")("ignored.example.com", {}, cb.fn);
    expect(cb.args).toEqual([null, "203.0.113.7", 4]);
  });

  it("returns an IPv6 address with family 6", () => {
    const cb = viFnCapture();
    pinnedLookup("2606:4700::1111")("ignored", {}, cb.fn);
    expect(cb.args).toEqual([null, "2606:4700::1111", 6]);
  });

  it("returns an address array when options.all is set", () => {
    const cb = viFnCapture();
    pinnedLookup("203.0.113.7")("ignored", { all: true }, cb.fn);
    expect(cb.args).toEqual([null, [{ address: "203.0.113.7", family: 4 }]]);
  });
});

describe("safeFetch", () => {
  it("connects to the pinned IP, not the hostname, preserving the Host header", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const target = `http://totally-not-loopback.example.com:${srv.port}/hook`;
    const { res, close } = await safeFetch(
      target,
      { method: "POST", body: "hello" },
      { resolve: pinTo("127.0.0.1", target) },
    );
    try {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      // The socket went to 127.0.0.1 (the pin) but the request advertised the
      // original hostname — proving we don't re-resolve the name at connect time.
      expect(srv.hits).toHaveLength(1);
      expect(srv.hits[0].method).toBe("POST");
      expect(srv.hits[0].body).toBe("hello");
      expect(srv.hits[0].host).toBe(
        `totally-not-loopback.example.com:${srv.port}`,
      );
    } finally {
      await close();
    }
  });

  it("does NOT follow redirects — returns the 3xx as-is", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data/",
      });
      res.end("redirecting");
    });
    const target = `http://redir.example.com:${srv.port}/r`;
    const { res, close } = await safeFetch(
      target,
      {},
      { resolve: pinTo("127.0.0.1", target) },
    );
    try {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "http://169.254.169.254/latest/meta-data/",
      );
      // Exactly one request reached the server: the redirect was not followed.
      expect(srv.hits).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("throws SsrfError (and makes no request) when the resolver blocks the target", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("should-not-be-hit");
    });
    const blocking = async () => {
      throw new SsrfError("destination resolves to blocked IP 169.254.169.254");
    };
    await expect(
      safeFetch(
        `http://evil.example.com:${srv.port}/`,
        {},
        { resolve: blocking },
      ),
    ).rejects.toThrow(SsrfError);
    expect(srv.hits).toHaveLength(0);
  });
});

// Tiny capture helper so pinnedLookup tests don't depend on vi internals.
function viFnCapture() {
  const box: { args: unknown[] } = { args: [] };
  return {
    get args() {
      return box.args;
    },
    fn: (...a: unknown[]) => {
      box.args = a;
    },
  };
}
