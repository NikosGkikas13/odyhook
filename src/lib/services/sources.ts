// src/lib/services/sources.ts
import crypto from "node:crypto";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import type { Page } from "@/lib/api/respond";

const VERIFY_STYLES = ["none", "stripe", "github", "generic-sha256"] as const;

export const sourceCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    verifyStyle: z.enum(VERIFY_STYLES).default("none"),
    signingSecret: z.string().optional(),
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
    createdAt: s.createdAt.toISOString(),
  };
}

function randomSlug(): string {
  return crypto.randomBytes(6).toString("base64url").toLowerCase();
}

export async function createSource(userId: string, input: SourceInput): Promise<SourceDTO> {
  const parsed = sourceCreateSchema.parse(input);
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
