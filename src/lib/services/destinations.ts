import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import { assertSafeUrl, SsrfError } from "@/lib/ssrf";
import type { Page } from "@/lib/api/respond";

// RFC 7230 token chars for header names.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII + space/tab; no CR/LF (prevents header smuggling at delivery).
const HEADER_VALUE_RE = /^[\t\x20-\x7E]*$/;

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const cleaned = line.replace(/\r$/, "");
    if (cleaned.trim() === "") continue;
    const idx = cleaned.indexOf(":");
    if (idx === -1) throw new Error(`Invalid header line (missing ':'): ${cleaned}`);
    const key = cleaned.slice(0, idx).trim();
    const value = cleaned.slice(idx + 1).trim();
    if (!key) continue;
    if (!HEADER_NAME_RE.test(key)) throw new Error(`Invalid header name: ${JSON.stringify(key)}`);
    if (!HEADER_VALUE_RE.test(value)) {
      throw new Error(`Invalid header value for ${key} (control chars not allowed)`);
    }
    out[key] = value;
  }
  return out;
}

export const destinationCreateSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  timeoutMs: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  headers: z.string().optional(), // "Key: Value" per line
  outboundSecret: z
    .string()
    .min(16, "Outbound signing secret must be at least 16 characters")
    .max(256)
    .optional()
    .or(z.literal("")),
});

export const destinationUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(60_000).optional(),
  headers: z.string().optional(),
  outboundSecret: z.string().min(16).max(256).optional().or(z.literal("")),
  enabled: z.boolean().optional(),
});

export type DestinationInput = z.input<typeof destinationCreateSchema>;
export type DestinationUpdateInput = z.input<typeof destinationUpdateSchema>;

export type DestinationDTO = {
  id: string;
  name: string;
  url: string;
  timeoutMs: number;
  enabled: boolean;
  hasHeaders: boolean;
  hasOutboundSecret: boolean;
  consecutiveFailures: number;
  autoDisabledAt: string | null;
  createdAt: string;
};

type DestinationRow = {
  id: string;
  name: string;
  url: string;
  timeoutMs: number;
  enabled: boolean;
  headersEnc: string | null;
  outboundSecretEnc: string | null;
  consecutiveFailures: number;
  autoDisabledAt: Date | null;
  createdAt: Date;
};

function toDTO(d: DestinationRow): DestinationDTO {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    timeoutMs: d.timeoutMs,
    enabled: d.enabled,
    hasHeaders: d.headersEnc != null,
    hasOutboundSecret: d.outboundSecretEnc != null,
    consecutiveFailures: d.consecutiveFailures,
    autoDisabledAt: d.autoDisabledAt ? d.autoDisabledAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}

async function assertUrlSafe(url: string): Promise<void> {
  try {
    await assertSafeUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) throw new Error(`Destination URL rejected: ${err.message}`);
    throw err;
  }
}

export async function createDestination(
  userId: string,
  input: DestinationInput,
): Promise<DestinationDTO> {
  const parsed = destinationCreateSchema.parse(input);
  const headers = parseHeaders(parsed.headers);
  const hasHeaders = Object.keys(headers).length > 0;
  const outboundSecret = parsed.outboundSecret?.trim() || null;
  await assertUrlSafe(parsed.url);

  const created = await prisma.destination.create({
    data: {
      userId,
      name: parsed.name,
      url: parsed.url,
      timeoutMs: parsed.timeoutMs,
      headersEnc: hasHeaders ? encryptJson(headers) : null,
      outboundSecretEnc: outboundSecret ? encrypt(outboundSecret) : null,
    },
  });
  return toDTO(created);
}

export async function listDestinations(
  userId: string,
  page: Page,
): Promise<{ data: DestinationDTO[]; nextCursor: string | null }> {
  const rows = await prisma.destination.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getDestination(userId: string, id: string): Promise<DestinationDTO | null> {
  const row = await prisma.destination.findFirst({ where: { id, userId } });
  return row ? toDTO(row) : null;
}

export async function updateDestination(
  userId: string,
  id: string,
  input: DestinationUpdateInput,
): Promise<DestinationDTO | null> {
  const parsed = destinationUpdateSchema.parse(input);
  const existing = await prisma.destination.findFirst({ where: { id, userId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.timeoutMs !== undefined) data.timeoutMs = parsed.timeoutMs;
  if (parsed.url !== undefined) {
    await assertUrlSafe(parsed.url);
    data.url = parsed.url;
  }
  if (parsed.headers !== undefined) {
    const headers = parseHeaders(parsed.headers);
    data.headersEnc = Object.keys(headers).length > 0 ? encryptJson(headers) : null;
  }
  if (parsed.outboundSecret !== undefined) {
    const s = parsed.outboundSecret.trim();
    data.outboundSecretEnc = s ? encrypt(s) : null;
  }
  if (parsed.enabled !== undefined) {
    data.enabled = parsed.enabled;
    if (parsed.enabled) {
      // Resuming clears breaker state, matching toggleDestinationEnabled.
      data.consecutiveFailures = 0;
      data.autoDisabledAt = null;
      data.autoDisabledReason = null;
    }
  }

  if (Object.keys(data).length === 0) {
    return toDTO(existing);
  }

  const updated = await prisma.destination.update({ where: { id }, data });
  return toDTO(updated);
}

export async function deleteDestination(userId: string, id: string): Promise<boolean> {
  const res = await prisma.destination.deleteMany({ where: { id, userId } });
  return res.count > 0;
}
