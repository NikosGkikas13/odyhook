import { NextResponse } from "next/server";

import { withApiAuth, readJson } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { createRoute, listRoutes } from "@/lib/services/routes";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const result = await listRoutes(auth.userId, parsePage(new URL(req.url)));
  return NextResponse.json(result);
});

export const POST = withApiAuth(async (req, auth) => {
  const dto = await createRoute(auth.userId, (await readJson(req)) as never);
  return NextResponse.json(dto, { status: 201 });
});
