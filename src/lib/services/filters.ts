import { prisma } from "@/lib/prisma";
import { compileRule } from "@/lib/ai/rule-compiler";
import type { FilterAst } from "@/lib/filters/evaluator";

/**
 * Compile a plain-English routing rule into a filter AST, grounded on the
 * source's most recent events. Preview only — does not persist. Verifies the
 * source belongs to the caller. Uses the caller's BYOK Anthropic key via
 * compileRule(); throws if no key is configured.
 */
export async function compileFilterForSource(
  userId: string,
  sourceId: string,
  prompt: string,
): Promise<{ ast: FilterAst; matchedCount: number; totalCount: number }> {
  const source = await prisma.source.findFirst({
    where: { id: sourceId, userId },
    select: { id: true },
  });
  if (!source) throw new Error("source not found");

  const recent = await prisma.event.findMany({
    where: { sourceId },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: { bodyRaw: true },
  });
  const samples: unknown[] = recent.map((e) => {
    try {
      return JSON.parse(e.bodyRaw);
    } catch {
      return { raw: e.bodyRaw };
    }
  });

  const result = await compileRule(userId, prompt, samples);
  return { ast: result.ast, matchedCount: result.matchedCount, totalCount: result.totalCount };
}
