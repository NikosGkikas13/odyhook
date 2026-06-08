import { llmFor } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import { fingerprintShape } from "@/lib/ai/diagnose";

// Schema-drift detection. For each source with recent traffic we compute a
// structural fingerprint of the last ~20 events and diff it against the
// previously stored fingerprint. If Claude says the shapes diverge we update
// the stored fingerprint and record the drift.
//
// This runs as a nightly cron (see scripts/drift.ts).

const SYSTEM_PROMPT = `You compare two structural fingerprints of webhook payloads and decide whether the event schema has drifted.

A fingerprint is a nested object describing key names and value *types* (string, number, boolean, null, array, nested object). No literal values.

Respond with STRICT JSON only, no prose:
  { "drifted": boolean, "summary": string, "added": string[], "removed": string[], "changed": string[] }

- "drifted" is true only if fields were added/removed or types changed. New optional fields should count as drift.
- "added" / "removed" / "changed" are JSONPath-lite strings ("$.data.object.new_field").
- "summary" is one short sentence suitable for an email subject.`;

export type DriftReport = {
  drifted: boolean;
  summary: string;
  added: string[];
  removed: string[];
  changed: string[];
};

async function claudeDiffFingerprints(
  userId: string,
  previous: unknown,
  current: unknown,
): Promise<DriftReport> {
  const llm = await llmFor(userId);
  const { text } = await llm.complete({
    tier: "cheap",
    maxTokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Previous fingerprint:`,
          "```json",
          JSON.stringify(previous, null, 2).slice(0, 4000),
          "```",
          ``,
          `Current fingerprint:`,
          "```json",
          JSON.stringify(current, null, 2).slice(0, 4000),
          "```",
        ].join("\n"),
      },
    ],
  });
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw
      .replace(/^```(?:json)?\n/, "")
      .replace(/\n```$/, "")
      .trim();
  }
  const parsed = JSON.parse(raw);
  return {
    drifted: Boolean(parsed.drifted),
    summary: String(parsed.summary ?? ""),
    added: Array.isArray(parsed.added) ? parsed.added.map(String) : [],
    removed: Array.isArray(parsed.removed) ? parsed.removed.map(String) : [],
    changed: Array.isArray(parsed.changed) ? parsed.changed.map(String) : [],
  };
}

/**
 * Sample recent events for a single source, build a combined fingerprint,
 * compare to the stored one, and persist the new fingerprint if it's the
 * first run or if drift was detected. Returns the report (or null if there
 * wasn't enough data to run).
 */
export async function checkSourceDrift(
  sourceId: string,
): Promise<DriftReport | null> {
  const source = await prisma.source.findUnique({
    where: { id: sourceId },
    include: { fingerprint: true },
  });
  if (!source) return null;

  const recent = await prisma.event.findMany({
    where: { sourceId },
    orderBy: { receivedAt: "desc" },
    take: 20,
    select: { bodyRaw: true },
  });
  if (recent.length < 3) return null;

  // Merge fingerprints across samples by fingerprinting each payload and
  // letting the later ones overwrite earlier ones. This is deliberately loose
  // — it's just a structural hint for the model.
  const merged: Record<string, unknown> = {};
  for (const row of recent) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.bodyRaw);
    } catch {
      continue;
    }
    const fp = fingerprintShape(parsed);
    if (fp && typeof fp === "object" && !Array.isArray(fp)) {
      Object.assign(merged, fp);
    }
  }

  if (!source.fingerprint) {
    // First run: store the baseline, no drift to report.
    await prisma.schemaFingerprint.create({
      data: {
        sourceId,
        fingerprint: merged as unknown as object,
      },
    });
    return null;
  }

  const previous = source.fingerprint.fingerprint as unknown;
  const report = await claudeDiffFingerprints(source.userId, previous, merged);

  if (report.drifted) {
    await prisma.schemaFingerprint.update({
      where: { sourceId },
      data: {
        fingerprint: merged as unknown as object,
        generatedAt: new Date(),
      },
    });
  }
  return report;
}
