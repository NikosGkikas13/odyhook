import { NextResponse } from "next/server";

import { withApiAuth, readJson } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { createSource, listSources } from "@/lib/services/sources";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const page = parsePage(new URL(req.url));
  const result = await listSources(auth.userId, page);
  return NextResponse.json(result);
});

export const POST = withApiAuth(async (req, auth) => {
  const body = await readJson(req);
  const dto = await createSource(auth.userId, body as never);
  return NextResponse.json(dto, { status: 201 });
});
