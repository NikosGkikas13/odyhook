import { NextResponse } from "next/server";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { getRoute, updateRoute, deleteRoute } from "@/lib/services/routes";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getRoute(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "route not found");
});

export const PATCH = withApiAuth(async (req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await updateRoute(auth.userId, id, (await readJson(req)) as never);
  return dto ? NextResponse.json(dto) : apiError("not_found", "route not found");
});

export const DELETE = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteRoute(auth.userId, id);
  return ok ? new NextResponse(null, { status: 204 }) : apiError("not_found", "route not found");
});
