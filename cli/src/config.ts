import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = { host: string; token: string };

/** Default config location: ~/.config/odyhook/config.json */
export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "odyhook", "config.json");
}

type LoadOpts = { env?: NodeJS.ProcessEnv; path?: string };

/**
 * Resolve config from env vars (highest priority, per field) then the file.
 * Returns null if either host or token is missing after merging.
 */
export function loadConfig(opts: LoadOpts = {}): Config | null {
  const env = opts.env ?? process.env;
  const path = opts.path ?? defaultConfigPath();

  let fileCfg: Partial<Config> = {};
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    } catch {
      fileCfg = {};
    }
  }

  const host = env.ODYHOOK_HOST ?? fileCfg.host;
  const token = env.ODYHOOK_TOKEN ?? fileCfg.token;
  if (!host || !token) return null;
  return { host, token };
}

/** Persist config to disk with 0600 permissions, creating parent dirs. */
export function saveConfig(cfg: Config, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // ensure mode even if the file pre-existed
}
