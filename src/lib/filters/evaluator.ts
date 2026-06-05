// Deterministic filter AST evaluator.
//
// The AI rule compiler turns plain-English rules into a small declarative AST
// that we evaluate at delivery time without calling the LLM. This keeps
// runtime cost at zero per event and makes behaviour testable.
//
// Supported nodes:
//   { and: [ ...nodes ] }
//   { or:  [ ...nodes ] }
//   { not: node }
//   { eq: [ path, literal ] }
//   { neq: [ path, literal ] }
//   { gt: [ path, number ] }
//   { gte: [ path, number ] }
//   { lt: [ path, number ] }
//   { lte: [ path, number ] }
//   { in: [ path, literal[] ] }
//   { contains: [ path, string ] }   // case-insensitive substring on strings
//   { startsWith: [ path, string ] } // case-insensitive prefix on strings
//   { endsWith:   [ path, string ] } // case-insensitive suffix on strings
//   { exists: path }                  // truthy if path resolves to anything not undefined
//
// Paths are JSONPath-lite: `$.data.amount`, `$.customer.address.country`.
// A leading `$.` is optional. Bracket notation is not supported.

export type JsonPath = string;

export type FilterAst =
  | { and: FilterAst[] }
  | { or: FilterAst[] }
  | { not: FilterAst }
  | { eq: [JsonPath, unknown] }
  | { neq: [JsonPath, unknown] }
  | { gt: [JsonPath, number] }
  | { gte: [JsonPath, number] }
  | { lt: [JsonPath, number] }
  | { lte: [JsonPath, number] }
  | { in: [JsonPath, unknown[]] }
  | { contains: [JsonPath, string] }
  | { startsWith: [JsonPath, string] }
  | { endsWith: [JsonPath, string] }
  | { exists: JsonPath };

/**
 * Read a value out of `event` using a dotted path. Returns undefined if any
 * intermediate step is missing. Arrays are indexed numerically (`$.items.0.id`).
 */
export function readPath(event: unknown, path: JsonPath): unknown {
  const trimmed = path.startsWith("$.")
    ? path.slice(2)
    : path.startsWith("$")
      ? path.slice(1)
      : path;
  if (!trimmed) return event;
  const parts = trimmed.split(".").filter(Boolean);
  let cur: unknown = event;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== "object") return undefined;
    // Own-property guard: a payload key of `__proto__` or `constructor`
    // would otherwise resolve to the JS prototype, making rules like
    // `{ exists: "$.__proto__" }` always true.
    if (!Object.hasOwn(cur as object, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Internal tri-state evaluation. Returns `true`/`false` for a recognised node,
 * or `null` when the node (or any descendant) is invalid/unrecognised.
 *
 * The `null` sentinel propagates *through* `and`/`or`/`not` rather than
 * collapsing to a boolean. This is what makes the fail-closed guarantee hold
 * under negation: `not(invalid)` stays `null` (→ false at the boundary), so a
 * malformed sub-node can never flip the filter to "forward". A `null` child
 * also poisons `and`/`or` so a corrupted slice of the AST can't be silently
 * ignored. For fully valid ASTs no node returns `null`, so behaviour is
 * identical to plain boolean logic.
 */
function evalNode(ast: FilterAst, event: unknown): boolean | null {
  if (!ast || typeof ast !== "object") return null;

  if ("and" in ast) {
    const rs = ast.and.map((n) => evalNode(n, event));
    if (rs.some((r) => r === null)) return null;
    return rs.every((r) => r === true);
  }
  if ("or" in ast) {
    const rs = ast.or.map((n) => evalNode(n, event));
    if (rs.some((r) => r === null)) return null;
    return rs.some((r) => r === true);
  }
  if ("not" in ast) {
    const r = evalNode(ast.not, event);
    return r === null ? null : !r;
  }

  if ("eq" in ast) {
    const [p, lit] = ast.eq;
    return readPath(event, p) === lit;
  }
  if ("neq" in ast) {
    const [p, lit] = ast.neq;
    return readPath(event, p) !== lit;
  }
  if ("gt" in ast) {
    const [p, lit] = ast.gt;
    const a = toNumber(readPath(event, p));
    return a !== null && a > lit;
  }
  if ("gte" in ast) {
    const [p, lit] = ast.gte;
    const a = toNumber(readPath(event, p));
    return a !== null && a >= lit;
  }
  if ("lt" in ast) {
    const [p, lit] = ast.lt;
    const a = toNumber(readPath(event, p));
    return a !== null && a < lit;
  }
  if ("lte" in ast) {
    const [p, lit] = ast.lte;
    const a = toNumber(readPath(event, p));
    return a !== null && a <= lit;
  }
  if ("in" in ast) {
    const [p, list] = ast.in;
    const v = readPath(event, p);
    return list.includes(v);
  }
  if ("contains" in ast) {
    const [p, needle] = ast.contains;
    const v = readPath(event, p);
    return typeof v === "string"
      ? v.toLowerCase().includes(needle.toLowerCase())
      : false;
  }
  if ("startsWith" in ast) {
    const [p, needle] = ast.startsWith;
    const v = readPath(event, p);
    return typeof v === "string"
      ? v.toLowerCase().startsWith(needle.toLowerCase())
      : false;
  }
  if ("endsWith" in ast) {
    const [p, needle] = ast.endsWith;
    const v = readPath(event, p);
    return typeof v === "string"
      ? v.toLowerCase().endsWith(needle.toLowerCase())
      : false;
  }
  if ("exists" in ast) {
    return readPath(event, ast.exists) !== undefined;
  }

  return null;
}

/**
 * Evaluate a filter AST against an event. Returns true only if the event
 * passes. An invalid or unrecognised node — at any depth, including under a
 * `not` — fails closed (returns false), so a malformed (e.g. hand-edited) AST
 * can never cause an event to be forwarded.
 */
export function evaluateFilter(ast: FilterAst, event: unknown): boolean {
  return evalNode(ast, event) === true;
}

/**
 * Shallow structural validation of an untrusted AST (e.g. loaded from the DB
 * or returned by Claude). Rejects unknown keys, wrong shapes, and nested
 * invalid children. Throws with a descriptive message on failure.
 */
// Cap nesting depth so a deeply-nested AST (via set_route_filter / create_route
// / saveRule) can't overflow the stack during validation. Generous vs real
// filters (a few levels); total node count is already bounded by the JSON body
// cap (readJsonLimited).
const MAX_FILTER_DEPTH = 100;

export function validateFilterAst(input: unknown, depth = 0): FilterAst {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`filter nesting too deep (max ${MAX_FILTER_DEPTH})`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("filter must be an object");
  }
  const o = input as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1) {
    throw new Error(`filter node must have exactly one key, got: ${keys.join(",")}`);
  }
  const key = keys[0];
  const val = o[key];

  switch (key) {
    case "and":
    case "or": {
      if (!Array.isArray(val) || val.length === 0) {
        throw new Error(`${key} must be a non-empty array`);
      }
      return { [key]: val.map((c) => validateFilterAst(c, depth + 1)) } as FilterAst;
    }
    case "not":
      return { not: validateFilterAst(val, depth + 1) };
    case "eq":
    case "neq":
    case "in":
    case "contains":
    case "startsWith":
    case "endsWith":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (!Array.isArray(val) || val.length !== 2) {
        throw new Error(`${key} must be a 2-element array [path, value]`);
      }
      const [p, lit] = val;
      if (typeof p !== "string") throw new Error(`${key} path must be a string`);
      if (key === "gt" || key === "gte" || key === "lt" || key === "lte") {
        if (typeof lit !== "number") {
          throw new Error(`${key} value must be a number`);
        }
      }
      if (key === "in" && !Array.isArray(lit)) {
        throw new Error(`in value must be an array`);
      }
      if (
        (key === "contains" || key === "startsWith" || key === "endsWith") &&
        typeof lit !== "string"
      ) {
        throw new Error(`${key} value must be a string`);
      }
      return { [key]: [p, lit] } as FilterAst;
    }
    case "exists": {
      if (typeof val !== "string") {
        throw new Error("exists value must be a path string");
      }
      return { exists: val };
    }
    default:
      throw new Error(`unknown filter node: ${key}`);
  }
}
