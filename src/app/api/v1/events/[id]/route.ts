import { NextResponse } from "next/server";

import { withApiAuth, apiError } from "@/lib/api/handler";
import { getEvent } from "@/lib/services/events";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getEvent(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "event not found");
});
