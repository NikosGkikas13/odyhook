import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { saveConfig, defaultConfigPath } from "../config.js";

export async function login(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const host = (await rl.question("Instance host URL (e.g. https://odyhook.dev): ")).trim();
    const token = (await rl.question("API token (ody_…): ")).trim();
    if (!host || !token) {
      console.error("Both host and token are required.");
      process.exitCode = 1;
      return;
    }
    if (!token.startsWith("ody_")) {
      console.error("That doesn't look like an Odyhook API token (should start with ody_).");
      process.exitCode = 1;
      return;
    }
    saveConfig({ host: host.replace(/\/+$/, ""), token });
    console.log(`Saved credentials to ${defaultConfigPath()}`);
  } finally {
    rl.close();
  }
}
