import type { FilterAst } from "@/lib/filters/evaluator";
import type { EventQuery, SourceRef } from "./types";

function field(path: string): string {
  return path.replace(/^\$\.?/, "");
}

function lit(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : String(v);
}

/** Render a filter AST as a compact human-readable string. */
export function describeFilterAst(ast: FilterAst): string {
  if ("and" in ast) return ast.and.map(describeFilterAst).join(" AND ");
  if ("or" in ast) return ast.or.map(describeFilterAst).join(" OR ");
  if ("not" in ast) return `NOT (${describeFilterAst(ast.not)})`;
  if ("eq" in ast) return `${field(ast.eq[0])} = ${lit(ast.eq[1])}`;
  if ("neq" in ast) return `${field(ast.neq[0])} ≠ ${lit(ast.neq[1])}`;
  if ("gt" in ast) return `${field(ast.gt[0])} > ${ast.gt[1]}`;
  if ("gte" in ast) return `${field(ast.gte[0])} ≥ ${ast.gte[1]}`;
  if ("lt" in ast) return `${field(ast.lt[0])} < ${ast.lt[1]}`;
  if ("lte" in ast) return `${field(ast.lte[0])} ≤ ${ast.lte[1]}`;
  if ("in" in ast) return `${field(ast.in[0])} in [${ast.in[1].map(lit).join(", ")}]`;
  if ("contains" in ast) return `${field(ast.contains[0])} contains ${lit(ast.contains[1])}`;
  if ("startsWith" in ast) return `${field(ast.startsWith[0])} starts with ${lit(ast.startsWith[1])}`;
  if ("endsWith" in ast) return `${field(ast.endsWith[0])} ends with ${lit(ast.endsWith[1])}`;
  if ("exists" in ast) return `${field(ast.exists)} exists`;
  return JSON.stringify(ast);
}

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Build human-readable chips describing what the query will run. */
export function describeEventQuery(
  query: EventQuery,
  sources: Pick<SourceRef, "id" | "name">[],
): string[] {
  const chips: string[] = [];
  const { metadata: m, payload } = query;

  if (m.sourceId) {
    const name = sources.find((s) => s.id === m.sourceId)?.name ?? m.sourceId;
    chips.push(`source: ${name}`);
  }
  if (m.receivedAfter && m.receivedBefore) {
    chips.push(`${fmtDate(m.receivedAfter)} – ${fmtDate(m.receivedBefore)}`);
  } else if (m.receivedAfter) {
    chips.push(`since ${fmtDate(m.receivedAfter)}`);
  } else if (m.receivedBefore) {
    chips.push(`before ${fmtDate(m.receivedBefore)}`);
  }
  if (m.status && m.status.length > 0) {
    chips.push(m.status.join(" / "));
  }
  if (payload) {
    chips.push(`body: ${describeFilterAst(payload)}`);
  }

  return chips.length > 0 ? chips : ["all events"];
}
