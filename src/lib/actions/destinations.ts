"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import { assertSafeUrl, SsrfError } from "@/lib/ssrf";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  timeoutMs: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  headers: z.string().optional(), // "Key: Value" per line
  // Optional outbound HMAC secret. Caller-supplied so they can pick a value
  // they've already shared with the downstream service. Stored encrypted.
  outboundSecret: z
    .string()
    .min(16, "Outbound signing secret must be at least 16 characters")
    .max(256)
    .optional()
    .or(z.literal("")),
});

// RFC 7230 token: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+"
// / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Header field value: visible ASCII + space/tab. No CR/LF — those would
// otherwise let a saved header smuggle a second header into the request
// at delivery time, and `fetch` rejects them by throwing.
const HEADER_VALUE_RE = /^[\t\x20-\x7E]*$/;

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    // Tolerate \r\n line endings.
    const cleaned = line.replace(/\r$/, "");
    if (cleaned.trim() === "") continue;
    const idx = cleaned.indexOf(":");
    if (idx === -1) {
      throw new Error(`Invalid header line (missing ':'): ${cleaned}`);
    }
    const key = cleaned.slice(0, idx).trim();
    const value = cleaned.slice(idx + 1).trim();
    if (!key) continue;
    if (!HEADER_NAME_RE.test(key)) {
      throw new Error(`Invalid header name: ${JSON.stringify(key)}`);
    }
    if (!HEADER_VALUE_RE.test(value)) {
      throw new Error(`Invalid header value for ${key} (control chars not allowed)`);
    }
    out[key] = value;
  }
  return out;
}

export async function createDestination(formData: FormData) {
  const userId = await requireUserId();
  const parsed = createSchema.parse({
    name: formData.get("name"),
    url: formData.get("url"),
    timeoutMs: formData.get("timeoutMs") ?? 10_000,
    headers: formData.get("headers") ?? "",
    outboundSecret: formData.get("outboundSecret") ?? "",
  });

  const headers = parseHeaders(parsed.headers);
  const hasHeaders = Object.keys(headers).length > 0;
  const outboundSecret = parsed.outboundSecret?.trim() || null;

  try {
    await assertSafeUrl(parsed.url);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new Error(`Destination URL rejected: ${err.message}`);
    }
    throw err;
  }

  await prisma.destination.create({
    data: {
      userId,
      name: parsed.name,
      url: parsed.url,
      timeoutMs: parsed.timeoutMs,
      headersEnc: hasHeaders ? encryptJson(headers) : null,
      outboundSecretEnc: outboundSecret ? encrypt(outboundSecret) : null,
    },
  });

  revalidatePath("/destinations");
}

export async function deleteDestination(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id"));
  await prisma.destination.deleteMany({ where: { id, userId } });
  revalidatePath("/destinations");
}

/**
 * Pause/resume a destination. When `enabled=false`, the ingest handler
 * skips creating deliveries for it and the worker refuses any already-
 * enqueued ones, leaving them as `exhausted` with a "destination paused"
 * error that the user can re-replay after re-enabling.
 */
export async function toggleDestinationEnabled(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id"));
  const existing = await prisma.destination.findFirst({
    where: { id, userId },
    select: { enabled: true },
  });
  if (!existing) throw new Error("not found");
  await prisma.destination.update({
    where: { id },
    data: { enabled: !existing.enabled },
  });
  revalidatePath("/destinations");
}
