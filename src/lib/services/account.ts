import { prisma } from "@/lib/prisma";

// Cap exported events so a large account can't OOM the box building one giant
// JSON document. Most accounts are far below this; the result flags `truncated`
// so callers (and the user) know when it bit.
export const EXPORT_EVENT_CAP = 10_000;

export interface AccountExport {
  truncated: boolean;
  account: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    createdAt: Date;
  } | null;
  sources: unknown[];
  destinations: unknown[];
  routes: unknown[];
  events: unknown[];
}

/**
 * Gather everything we hold for a user, owner-scoped, for a GDPR Art. 15
 * export. Encrypted-at-rest secrets (source signing secrets, destination
 * headers, the BYOK Anthropic key) are deliberately excluded — exporting
 * plaintext secrets would be a new exfiltration surface and they aren't
 * personal data the user lacks.
 */
export async function exportAccountData(userId: string): Promise<AccountExport> {
  const [account, sources, destinations, routes, events] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, image: true, createdAt: true },
    }),
    prisma.source.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        slug: true,
        verifyStyle: true,
        rateLimitPerSec: true,
        rateLimitBurst: true,
        retentionDays: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.destination.findMany({
      where: { userId },
      // Note: headersEnc / outboundSecretEnc intentionally omitted.
      select: {
        id: true,
        name: true,
        url: true,
        enabled: true,
        timeoutMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.route.findMany({
      where: { source: { userId } },
      select: {
        id: true,
        sourceId: true,
        destinationId: true,
        enabled: true,
        filterPrompt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.event.findMany({
      where: { source: { userId } },
      take: EXPORT_EVENT_CAP + 1,
      orderBy: { receivedAt: "desc" },
      select: {
        id: true,
        sourceId: true,
        method: true,
        headersJson: true,
        bodyRaw: true,
        receivedAt: true,
        remoteIp: true,
        idempotencyKey: true,
        deliveries: {
          select: {
            id: true,
            destinationId: true,
            status: true,
            attemptCount: true,
            responseCode: true,
            lastError: true,
            deliveredAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  const truncated = events.length > EXPORT_EVENT_CAP;
  return {
    truncated,
    account,
    sources,
    destinations,
    routes,
    events: truncated ? events.slice(0, EXPORT_EVENT_CAP) : events,
  };
}

/**
 * GDPR Art. 17 erasure. Deletes the user row; every owned row across the schema
 * is removed by the `onDelete: Cascade` relations. Idempotent at the call site:
 * Prisma throws P2025 if the user is already gone, which callers can ignore.
 */
export async function deleteUserAccount(userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}
