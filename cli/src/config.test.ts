import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, saveConfig } from "./config";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ody-cfg-"));
  path = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  it("returns null when no file and no env", () => {
    expect(loadConfig({ env: {}, path })).toBeNull();
  });

  it("saves and loads host + token", () => {
    saveConfig({ host: "https://odyhook.dev", token: "ody_abc" }, path);
    expect(loadConfig({ env: {}, path })).toEqual({
      host: "https://odyhook.dev",
      token: "ody_abc",
    });
  });

  it("writes the file with 0600 permissions", () => {
    saveConfig({ host: "https://x", token: "ody_x" }, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).host).toBe("https://x");
  });

  it("env vars override the file per field", () => {
    saveConfig({ host: "https://file", token: "ody_file" }, path);
    expect(
      loadConfig({ env: { ODYHOOK_HOST: "https://env" }, path }),
    ).toEqual({ host: "https://env", token: "ody_file" });
  });

  it("returns null when a field is missing from both env and file", () => {
    expect(loadConfig({ env: { ODYHOOK_HOST: "https://env" }, path })).toBeNull();
  });
});
