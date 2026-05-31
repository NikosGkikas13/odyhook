#!/usr/bin/env node
import { login } from "./commands/login.js";
import { listen } from "./commands/listen.js";

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      await login();
      break;
    case "listen":
      await listen(process.argv.slice(3));
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printUsage();
      process.exitCode = 1;
  }
}

function printUsage(): void {
  console.log(
    [
      "ody — Odyhook CLI",
      "",
      "Usage:",
      "  ody login                          Save instance host + API token",
      "  ody listen --source <slug> --forward <url> [--since <dur>]",
      "  ody trigger <slug> --data @file.json [--header K:V]...",
      "  ody trigger <slug> --replay <eventId>",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
