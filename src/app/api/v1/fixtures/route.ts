import { NextResponse } from "next/server";
import { z } from "zod";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { prisma } from "@/lib/prisma";
import { llmFor, NoLlmKeyError } from "@/lib/llm";
import { generateFixture, FixtureGenerationError } from "@/lib/ai/fixtures";

export const runtime = "nodejs";

const FixtureInput = z.object({
  source: z.string().min(1),
  prompt: z.string().min(1),
});

export const POST = withApiAuth(async (req, auth) => {
  const { source, prompt } = FixtureInput.parse(await readJson(req));

  const src = await prisma.source.findFirst({
    where: { slug: source, userId: auth.userId },
    select: { id: true, verifyStyle: true },
  });
  if (!src) return apiError("not_found", "source not found");

  let llm;
  try {
    llm = await llmFor(auth.userId);
  } catch (err) {
    if (err instanceof NoLlmKeyError) {
      return apiError("validation_error", err.message);
    }
    throw err;
  }

  const samples = await prisma.event.findMany({
    where: { sourceId: src.id },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { bodyRaw: true },
  });

  try {
    const result = await generateFixture({
      llm,
      prompt,
      sampleBodies: samples.map((s) => s.bodyRaw),
      verifyStyle: src.verifyStyle,
    });
    return NextResponse.json(result);
  } catch (err) {
    // Bad model output is a user-facing 400. Anything else (Anthropic network/
    // auth/SDK errors) rethrows → 500 via withApiAuth, so Sentry captures it
    // and no raw SDK message leaks to the caller.
    if (err instanceof FixtureGenerationError) {
      return apiError("validation_error", err.message);
    }
    throw err;
  }
});
