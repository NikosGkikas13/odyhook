import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";

// Delivery statuses, mirrored as a runtime list (the generated Prisma enum is a
// type only at this layer). Keep in sync with prisma/schema.prisma DeliveryStatus.
export const DELIVERY_STATUSES = [
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "exhausted",
] as const;
export type DeliveryStatusValue = (typeof DELIVERY_STATUSES)[number];

export type SourceRef = { id: string; name: string; slug: string };

export type EventQuery = {
  metadata: {
    sourceId: string | null;
    receivedAfter: string | null; // ISO 8601
    receivedBefore: string | null; // ISO 8601
    status: DeliveryStatusValue[] | null; // one or more; e.g. ["failed","exhausted"]
  };
  payload: FilterAst | null;
};

function normIso(label: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`${label} must be an ISO date string or null`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a valid date: ${v}`);
  return new Date(ms).toISOString();
}

/** Validate untrusted input (Claude output or a URL param) into an EventQuery.
 *  Throws a descriptive Error on any mismatch. Does NOT check source ownership —
 *  that is enforced structurally by buildEventWhere (source: { userId }). */
export function validateEventQuery(input: unknown): EventQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("query must be an object");
  }
  const o = input as Record<string, unknown>;
  const md = o.metadata;
  if (!md || typeof md !== "object" || Array.isArray(md)) {
    throw new Error("query.metadata must be an object");
  }
  const m = md as Record<string, unknown>;

  const sourceId = m.sourceId == null ? null : String(m.sourceId);

  let status: DeliveryStatusValue[] | null = null;
  if (m.status != null) {
    if (!Array.isArray(m.status)) throw new Error("status must be an array or null");
    const vals = m.status.map((s) => {
      if (typeof s !== "string" || !(DELIVERY_STATUSES as readonly string[]).includes(s)) {
        throw new Error(`unknown status value: ${String(s)}`);
      }
      return s as DeliveryStatusValue;
    });
    status = vals.length > 0 ? vals : null;
  }

  const payload = o.payload == null ? null : validateFilterAst(o.payload);

  return {
    metadata: {
      sourceId,
      receivedAfter: normIso("receivedAfter", m.receivedAfter),
      receivedBefore: normIso("receivedBefore", m.receivedBefore),
      status,
    },
    payload,
  };
}
