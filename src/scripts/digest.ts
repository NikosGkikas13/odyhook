// Weekly digest entry point.
// Run via: `npm run job:digest`. Schedule externally (Mondays 9am local).
//
// For each user with activity in the last 7 days, build stats and render a
// digest email body via Claude Haiku, then send it via the shared SMTP
// transport. Set DIGEST_DRY_RUN=1 to print to stdout instead — useful
// for first-time setup and CI.

import "dotenv/config";

import { prisma } from "../lib/prisma";
import { buildDigestStats, renderDigestEmail } from "../lib/ai/digest";
import { sendMail } from "../lib/mailer";

async function main() {
  const dryRun = process.env.DIGEST_DRY_RUN === "1";
  const users = await prisma.user.findMany({
    where: { activeAiProvider: { not: null } },
    select: { id: true, email: true, name: true },
  });
  console.log(
    `[digest] running for ${users.length} users with api keys${dryRun ? " (DRY RUN)" : ""}`,
  );

  for (const u of users) {
    try {
      const stats = await buildDigestStats(u.id);
      if (stats.length === 0) {
        console.log(`[digest] ${u.email}: no activity, skipping`);
        continue;
      }
      const body = await renderDigestEmail(u.id, stats);
      if (!body) {
        console.log(`[digest] ${u.email}: nothing to send`);
        continue;
      }
      if (dryRun) {
        console.log(`\n===== DIGEST for ${u.email} =====\n${body}\n`);
        continue;
      }
      await sendMail({
        to: u.email,
        subject: "Your Odyhook weekly digest",
        text: body,
      });
      console.log(`[digest] ${u.email}: sent`);
    } catch (err) {
      console.error(`[digest] ${u.email}: error`, err);
    }
  }
}

main()
  .catch((err) => {
    console.error("[digest] fatal", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
