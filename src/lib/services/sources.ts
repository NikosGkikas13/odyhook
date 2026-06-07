// src/lib/services/sources.ts
import crypto from "node:crypto";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { assertWithinQuota } from "@/lib/quota";
import type { Page } from "@/lib/api/respond";

const VERIFY_STYLES = ["none", "stripe", "github", "generic-sha256"] as const;

// New sources keep events for 90 days by default; the purge job enforces it.
// Null retention means keep indefinitely. Capped at 365 to bound disk + the
// GDPR storage-limitation exposure.
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 365;

const retentionSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_RETENTION_DAYS)
  .nullable();

export const sourceCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    verifyStyle: z.enum(VERIFY_STYLES).default("none"),
    signingSecret: z.string().optional(),
    retentionDays: retentionSchema.default(DEFAULT_RETENTION_DAYS),
  })
  .refine(
    (v) => v.verifyStyle === "none" || (v.signingSecret?.trim().length ?? 0) > 0,
    { message: "signing secret is required when verifyStyle is set", path: ["signingSecret"] },
  );

export const sourceUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    verifyStyle: z.enum(VERIFY_STYLES).optional(),
    signingSecret: z.string().optional(),
    rateLimitPerSec: z.number().int().positive().nullable().optional(),
    rateLimitBurst: z.number().int().positive().nullable().optional(),
    retentionDays: retentionSchema.optional(),
  });

export type SourceInput = z.input<typeof sourceCreateSchema>;
export type SourceUpdateInput = z.input<typeof sourceUpdateSchema>;

export type SourceDTO = {
  id: string;
  name: string;
  slug: string;
  verifyStyle: string | null;
  hasSigningSecret: boolean;
  rateLimitPerSec: number | null;
  rateLimitBurst: number | null;
  retentionDays: number | null;
  createdAt: string;
};

type SourceRow = {
  id: string;
  name: string;
  slug: string;
  verifyStyle: string | null;
  signingSecret: string | null;
  rateLimitPerSec: number | null;
  rateLimitBurst: number | null;
  retentionDays: number | null;
  createdAt: Date;
};

function toDTO(s: SourceRow): SourceDTO {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    verifyStyle: s.verifyStyle,
    hasSigningSecret: s.signingSecret != null,
    rateLimitPerSec: s.rateLimitPerSec,
    rateLimitBurst: s.rateLimitBurst,
    retentionDays: s.retentionDays,
    createdAt: s.createdAt.toISOString(),
  };
}

// 16 random bytes → 128-bit, 22-char base64url slug. The slug is an ambient
// bearer capability (anyone who knows it can POST to /api/ingest/<slug>), so it
// must not be guessable at scale — the old 6-byte (~48-bit) slug was. Kept
// case-sensitive (lookups are exact-match) to preserve the full 128 bits.
export function randomSlug(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export async function createSource(userId: string, input: SourceInput): Promise<SourceDTO> {
  const parsed = sourceCreateSchema.parse(input);
  await assertWithinQuota(userId, "sources");
  const created = await prisma.source.create({
    data: {
      userId,
      name: parsed.name,
      slug: randomSlug(),
      verifyStyle: parsed.verifyStyle === "none" ? null : parsed.verifyStyle,
      signingSecret:
        parsed.verifyStyle !== "none" && parsed.signingSecret
          ? encrypt(parsed.signingSecret)
          : null,
      retentionDays: parsed.retentionDays,
    },
  });
  return toDTO(created);
}

export async function listSources(
  userId: string,
  page: Page,
): Promise<{ data: SourceDTO[]; nextCursor: string | null }> {
  const rows = await prisma.source.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getSource(userId: string, id: string): Promise<SourceDTO | null> {
  const row = await prisma.source.findFirst({ where: { id, userId } });
  return row ? toDTO(row) : null;
}

export async function updateSource(
  userId: string,
  id: string,
  input: SourceUpdateInput,
): Promise<SourceDTO | null> {
  const parsed = sourceUpdateSchema.parse(input);
  const existing = await prisma.source.findFirst({ where: { id, userId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.rateLimitPerSec !== undefined) data.rateLimitPerSec = parsed.rateLimitPerSec;
  if (parsed.rateLimitBurst !== undefined) data.rateLimitBurst = parsed.rateLimitBurst;
  if (parsed.retentionDays !== undefined) data.retentionDays = parsed.retentionDays;
  if (parsed.verifyStyle !== undefined) {
    if (parsed.verifyStyle === "none") {
      data.verifyStyle = null;
      data.signingSecret = null;
    } else {
      data.verifyStyle = parsed.verifyStyle;
      if (parsed.signingSecret?.trim()) {
        data.signingSecret = encrypt(parsed.signingSecret);
      } else if (existing.signingSecret == null) {
        // No new secret supplied AND none on record → genuinely missing.
        throw new z.ZodError([
          { code: "custom", path: ["signingSecret"], message: "signing secret is required when verifyStyle is set" },
        ]);
      }
      // else: keep the existing encrypted secret (no change to that column)
    }
  }

  if (Object.keys(data).length === 0) {
    return toDTO(existing);
  }

  const updated = await prisma.source.update({ where: { id }, data });
  return toDTO(updated);
}

export async function deleteSource(userId: string, id: string): Promise<boolean> {
  const res = await prisma.source.deleteMany({ where: { id, userId } });
  return res.count > 0;
}
