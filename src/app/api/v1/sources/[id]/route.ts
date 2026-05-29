import { NextResponse } from "next/server";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { getSource, updateSource, deleteSource } from "@/lib/services/sources";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getSource(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "source not found");
});

export const PATCH = withApiAuth(async (req, auth, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const dto = await updateSource(auth.userId, id, body as never);
  return dto ? NextResponse.json(dto) : apiError("not_found", "source not found");
});

export const DELETE = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteSource(auth.userId, id);
  return ok ? new NextResponse(null, { status: 204 }) : apiError("not_found", "source not found");
});
