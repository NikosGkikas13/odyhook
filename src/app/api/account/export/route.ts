import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { exportAccountData, EXPORT_EVENT_CAP } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GDPR Art. 15 data export. Returns a JSON document of everything we hold for
 * the signed-in user as a downloadable attachment. Encrypted-at-rest secrets
 * are excluded — see exportAccountData. GET, so no CSRF needed; auth is
 * enforced here and by the proxy matcher.
 */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const data = await exportAccountData(userId);
  const exportDoc = {
    exportedAt: new Date().toISOString(),
    note: "Data export from odyhook.dev. Encrypted secrets (signing secrets, destination headers, Anthropic key) are not included.",
    ...data,
    eventCap: data.truncated ? EXPORT_EVENT_CAP : undefined,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(exportDoc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="odyhook-export-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
