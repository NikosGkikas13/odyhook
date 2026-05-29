import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { listEvents } from "@/lib/services/events";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const result = await listEvents(auth.userId, parsePage(new URL(req.url)));
  return NextResponse.json(result);
});
