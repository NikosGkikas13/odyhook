import { NextResponse } from "next/server";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { getDestination, updateDestination, deleteDestination } from "@/lib/services/destinations";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getDestination(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "destination not found");
});

export const PATCH = withApiAuth(async (req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await updateDestination(auth.userId, id, (await readJson(req)) as never);
  return dto ? NextResponse.json(dto) : apiError("not_found", "destination not found");
});

export const DELETE = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteDestination(auth.userId, id);
  return ok ? new NextResponse(null, { status: 204 }) : apiError("not_found", "destination not found");
});
