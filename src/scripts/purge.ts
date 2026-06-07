// Daily retention-purge entry point.
// Run via: `npm run job:purge`. Schedule externally (cron, GitHub Actions, etc).
//
// Deletes events older than each source's configured retention window
// (Source.retentionDays). Sources with null retention are kept indefinitely.
// Deliveries and AI diffs/diagnoses cascade-delete with their events.

import "dotenv/config";

import { prisma } from "../lib/prisma";
import { purgeExpiredEvents } from "../lib/services/retention";

async function main() {
  const res = await purgeExpiredEvents();
  console.log(
    `[purge] deleted ${res.eventsDeleted} expired event(s) across ${res.sourcesProcessed} source(s) with a retention window`,
  );
}

main()
  .catch((err) => {
    console.error("[purge] fatal", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
