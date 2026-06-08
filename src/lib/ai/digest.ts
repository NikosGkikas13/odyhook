import { llmFor } from "@/lib/llm";
import { prisma } from "@/lib/prisma";

// Weekly AI digest. Aggregates per-source stats for the last 7 days and asks
// Claude (Haiku, cheap) to turn them into a short markdown email body.
// Runs from scripts/digest.ts.

const SYSTEM_PROMPT = `You write a short weekly webhook digest for a developer.

You are given per-source stats for the last 7 days. Produce a markdown email body:
- One paragraph per source, in descending order of event volume.
- Highlight anomalies: large volume changes, elevated failure rates, repeated exhausted deliveries, or new event types.
- Be concrete, terse, and skimmable. Max ~200 words total.
- Do NOT invent statistics — only comment on what's in the input.
- No greeting, no sign-off, just the body.`;

export type DigestSourceStats = {
  sourceName: string;
  totalEvents: number;
  delivered: number;
  failed: number;
  exhausted: number;
  exhaustedDestinations: string[];
  topEventTypes: { type: string; count: number }[];
};

/**
 * Build digest stats for one user for the last 7 days. Pure DB work, no LLM.
 */
export async function buildDigestStats(
  userId: string,
): Promise<DigestSourceStats[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const sources = await prisma.source.findMany({
    where: { userId },
    include: {
      events: {
        where: { receivedAt: { gte: since } },
        select: {
          bodyRaw: true,
          deliveries: {
            select: {
              status: true,
              destination: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const out: DigestSourceStats[] = [];
  for (const s of sources) {
    if (s.events.length === 0) continue;

    let delivered = 0;
    let failed = 0;
    let exhausted = 0;
    const exhaustedDests = new Set<string>();
    const typeCounts = new Map<string, number>();

    for (const e of s.events) {
      for (const d of e.deliveries) {
        if (d.status === "delivered") delivered++;
        else if (d.status === "failed") failed++;
        else if (d.status === "exhausted") {
          exhausted++;
          exhaustedDests.add(d.destination.name);
        }
      }
      // Best-effort guess at event "type" — most providers use a top-level
      // `type` field. Skip otherwise.
      try {
        const parsed = JSON.parse(e.bodyRaw);
        if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
          const t = (parsed as { type: string }).type;
          typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
        }
      } catch {
        // ignore non-JSON bodies
      }
    }

    const topEventTypes = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    out.push({
      sourceName: s.name,
      totalEvents: s.events.length,
      delivered,
      failed,
      exhausted,
      exhaustedDestinations: [...exhaustedDests],
      topEventTypes,
    });
  }

  out.sort((a, b) => b.totalEvents - a.totalEvents);
  return out;
}

/**
 * Turn digest stats into a markdown email body via Claude Haiku. Returns null
 * if the user has no activity or no API key configured.
 */
export async function renderDigestEmail(
  userId: string,
  stats: DigestSourceStats[],
): Promise<string | null> {
  if (stats.length === 0) return null;
  const llm = await llmFor(userId);

  const { text } = await llm.complete({
    tier: "cheap",
    maxTokens: 700,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Weekly stats:`,
          "```json",
          JSON.stringify(stats, null, 2),
          "```",
          ``,
          `Write the digest body.`,
        ].join("\n"),
      },
    ],
  });
  return text.trim();
}
