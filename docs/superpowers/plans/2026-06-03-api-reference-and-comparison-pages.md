# API Reference + Competitor Comparison Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a static `/docs/api-reference` page rendered from the OpenAPI spec, plus honest, datestamped `/vs/hookdeck` and `/vs/svix` comparison pages.

**Architecture:** A pure build-time OpenAPI model layer (`src/lib/openapi/`) feeds a static server-component reference page inside the existing `/docs` layout. A typed comparison dataset (`src/lib/marketing/comparisons.ts`) feeds a shared `<ComparisonPage>` server component rendered by two thin static route pages. No dynamic (request-time) APIs anywhere — all three pages prerender (`○`).

**Tech Stack:** Next.js 16 (App Router, server components), TypeScript (strict), Vitest 4 (node env), Tailwind 4, existing marketing/docs design tokens.

**Spec:** `docs/superpowers/specs/2026-06-03-api-reference-and-comparison-pages-design.md`

**Conventions to follow:**
- Tests are `*.test.ts`, node environment, no DB/setup (see `vitest.config.ts`).
- Marketing CSS classes already exist: `marketing-h1`, `marketing-lede`, `docs-prose` (styles `<table>`), `btn-primary-ody`.
- Commit messages end with the Claude co-author trailer used elsewhere in this repo.
- Branch is already `feat/api-reference-and-comparison-pages` (off `main`).

---

## Task 1: OpenAPI types + spec import

**Files:**
- Create: `src/lib/openapi/spec.ts`

- [ ] **Step 1: Create the spec module with minimal structural types**

`src/lib/openapi/spec.ts`:

```ts
// Minimal structural types for the parts of the OpenAPI 3.1 document the docs
// reference renders. Not a full OpenAPI type — just what src/lib/openapi/model.ts
// touches. The spec itself lives at public/openapi.json (served at /openapi.json)
// and is imported statically so the reference page can prerender at build time.
import rawSpec from "../../../public/openapi.json";

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema & { readOnly?: boolean }>;
  items?: JsonSchema;
  $ref?: string;
  enum?: (string | number | boolean)[];
  format?: string;
};

export type Parameter = {
  name: string;
  in: "query" | "path" | "header";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  $ref?: string;
};

export type MediaContent = {
  content?: Record<string, { schema?: JsonSchema }>;
};

export type Response = MediaContent & {
  description?: string;
  $ref?: string;
};

export type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean } & MediaContent;
  responses?: Record<string, Response>;
};

export type PathItem = Record<string, Operation> & { parameters?: Parameter[] };

export type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, JsonSchema>;
    parameters?: Record<string, Parameter>;
    responses?: Record<string, Response>;
    securitySchemes?: Record<string, unknown>;
  };
};

export const spec = rawSpec as unknown as OpenApiSpec;
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: clean (no errors). If it errors on the JSON import, confirm `resolveJsonModule` is enabled in `tsconfig.json` (Next.js enables it by default — it should already pass).

- [ ] **Step 3: Commit**

```bash
git add src/lib/openapi/spec.ts
git commit -m "feat(openapi): typed import of the OpenAPI spec for the docs reference

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: OpenAPI model — schemas + ref resolution + type formatting

**Files:**
- Create: `src/lib/openapi/model.ts`
- Test: `src/lib/openapi/model.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/openapi/model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { spec } from "./spec";
import { refName, resolveRef, formatType, getSchemas } from "./model";

describe("refName", () => {
  it("returns the last path segment of a $ref", () => {
    expect(refName("#/components/schemas/Source")).toBe("Source");
  });
});

describe("resolveRef", () => {
  it("resolves a schema ref to the schema object", () => {
    const err = resolveRef<{ type?: string }>(spec, "#/components/schemas/Error");
    expect(err).toBeTruthy();
    expect(err.type).toBe("object");
  });
});

describe("formatType", () => {
  it("joins union types with a pipe", () => {
    expect(formatType({ type: ["string", "null"] })).toBe("string | null");
  });
  it("appends the format in parentheses", () => {
    expect(formatType({ type: "string", format: "date-time" })).toBe(
      "string (date-time)",
    );
  });
  it("renders an array of refs as Name[]", () => {
    expect(formatType({ items: { $ref: "#/components/schemas/Source" } })).toBe(
      "Source[]",
    );
  });
  it("renders a bare $ref as the schema name", () => {
    expect(formatType({ $ref: "#/components/schemas/Delivery" })).toBe(
      "Delivery",
    );
  });
});

describe("getSchemas", () => {
  it("returns every component schema", () => {
    const schemas = getSchemas(spec);
    expect(schemas.length).toBe(Object.keys(spec.components.schemas).length);
  });
  it("marks required fields from the schema's required array", () => {
    const source = getSchemas(spec).find((s) => s.name === "Source");
    expect(source).toBeTruthy();
    const id = source!.fields.find((f) => f.name === "id");
    expect(id?.required).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/openapi/model.test.ts`
Expected: FAIL — `model.ts` does not exist / exports undefined.

- [ ] **Step 3: Write the minimal implementation**

`src/lib/openapi/model.ts`:

```ts
import { spec as defaultSpec, type JsonSchema, type OpenApiSpec } from "./spec";

export function refName(ref: string): string {
  return ref.split("/").pop() as string;
}

export function resolveRef<T = unknown>(s: OpenApiSpec, ref: string): T {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = s;
  for (const p of parts) {
    cur = (cur as Record<string, unknown> | undefined)?.[p];
  }
  return cur as T;
}

export function formatType(schema: JsonSchema): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.items) {
    const inner = schema.items.$ref
      ? refName(schema.items.$ref)
      : formatType(schema.items);
    return `${inner}[]`;
  }
  if (schema.enum) {
    return schema.enum.map((e) => JSON.stringify(e)).join(" | ");
  }
  const base = Array.isArray(schema.type)
    ? schema.type.join(" | ")
    : (schema.type ?? "object");
  return schema.format ? `${base} (${schema.format})` : base;
}

export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  readOnly: boolean;
  description?: string;
};

export type RenderedSchema = {
  name: string;
  description?: string;
  fields: SchemaField[];
};

export function getSchemas(s: OpenApiSpec = defaultSpec): RenderedSchema[] {
  return Object.entries(s.components.schemas).map(([name, schema]) => ({
    name,
    description: schema.description,
    fields: Object.entries(schema.properties ?? {}).map(([fname, fs]) => ({
      name: fname,
      type: formatType(fs),
      required: (schema.required ?? []).includes(fname),
      readOnly: Boolean(fs.readOnly),
      description: fs.description,
    })),
  }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/openapi/model.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi/model.ts src/lib/openapi/model.test.ts
git commit -m "feat(openapi): schema rendering + ref resolution + type formatting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: OpenAPI model — operation grouping

**Files:**
- Modify: `src/lib/openapi/model.ts` (append)
- Test: `src/lib/openapi/model.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to model.test.ts)**

```ts
import { getOperationGroups } from "./model";

describe("getOperationGroups", () => {
  it("groups operations by resource derived from the path", () => {
    const groups = getOperationGroups(spec);
    const resources = groups.map((g) => g.resource);
    expect(resources).toContain("Sources");
    expect(resources).toContain("Destinations");
    expect(resources).toContain("Routes");
    expect(resources).toContain("Events");
  });

  it("lists GET and POST on the sources collection", () => {
    const sources = getOperationGroups(spec).find((g) => g.resource === "Sources")!;
    const methods = sources.operations
      .filter((o) => o.path === "/api/v1/sources")
      .map((o) => o.method);
    expect(methods).toEqual(expect.arrayContaining(["GET", "POST"]));
  });

  it("resolves $ref parameters (limit/cursor) on list endpoints", () => {
    const sources = getOperationGroups(spec).find((g) => g.resource === "Sources")!;
    const list = sources.operations.find(
      (o) => o.path === "/api/v1/sources" && o.method === "GET",
    )!;
    const names = list.parameters.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["limit", "cursor"]));
  });

  it("resolves the request body schema name for create endpoints", () => {
    const sources = getOperationGroups(spec).find((g) => g.resource === "Sources")!;
    const create = sources.operations.find(
      (o) => o.path === "/api/v1/sources" && o.method === "POST",
    )!;
    expect(create.requestSchemaRef).toBe("SourceCreate");
  });

  it("resolves $ref responses to their schema (Unauthorized -> Error)", () => {
    const sources = getOperationGroups(spec).find((g) => g.resource === "Sources")!;
    const list = sources.operations.find(
      (o) => o.path === "/api/v1/sources" && o.method === "GET",
    )!;
    const r401 = list.responses.find((r) => r.status === "401")!;
    expect(r401.schemaRef).toBe("Error");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/openapi/model.test.ts`
Expected: FAIL — `getOperationGroups` is not exported.

- [ ] **Step 3: Write the minimal implementation (append to model.ts)**

First, extend the **existing** top-of-file import (do NOT add a second
`from "./spec"` line — that trips `no-duplicate-imports` during the build's lint).
Change the line written in Task 2:

```ts
import { spec as defaultSpec, type JsonSchema, type OpenApiSpec } from "./spec";
```

to:

```ts
import {
  spec as defaultSpec,
  type JsonSchema,
  type OpenApiSpec,
  type Operation,
  type Parameter,
  type PathItem,
  type Response,
} from "./spec";
```

Then append the rest:

```ts
const RESOURCE_BY_SEGMENT: Record<string, string> = {
  sources: "Sources",
  destinations: "Destinations",
  routes: "Routes",
  events: "Events",
};

const METHODS = ["get", "post", "patch", "put", "delete"] as const;

export type RenderedParam = {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description?: string;
};

export type RenderedResponse = {
  status: string;
  description?: string;
  schemaRef?: string;
};

export type RenderedOperation = {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters: RenderedParam[];
  requestSchemaRef?: string;
  responses: RenderedResponse[];
};

export type OperationGroup = {
  resource: string;
  operations: RenderedOperation[];
};

function resolveParam(s: OpenApiSpec, p: Parameter): RenderedParam {
  const param = p.$ref ? resolveRef<Parameter>(s, p.$ref) : p;
  return {
    name: param.name,
    in: param.in,
    required: Boolean(param.required),
    type: param.schema ? formatType(param.schema) : "string",
    description: param.description,
  };
}

function jsonSchemaRef(content: Response["content"]): string | undefined {
  const schema = content?.["application/json"]?.schema;
  return schema?.$ref ? refName(schema.$ref) : undefined;
}

export function getOperationGroups(s: OpenApiSpec = defaultSpec): OperationGroup[] {
  const groups = new Map<string, RenderedOperation[]>();

  for (const [path, item] of Object.entries(s.paths)) {
    const pathItem = item as PathItem;
    const segment = path.split("/").filter(Boolean)[2] ?? path;
    const resource = RESOURCE_BY_SEGMENT[segment] ?? segment;
    const sharedParams = pathItem.parameters ?? [];

    for (const method of METHODS) {
      const op = pathItem[method] as Operation | undefined;
      if (!op) continue;

      const parameters = [...sharedParams, ...(op.parameters ?? [])].map((p) =>
        resolveParam(s, p),
      );

      const requestSchemaRef = jsonSchemaRef(op.requestBody?.content);

      const responses: RenderedResponse[] = Object.entries(
        op.responses ?? {},
      ).map(([status, r]) => {
        const resp = r.$ref ? resolveRef<Response>(s, r.$ref) : r;
        return {
          status,
          description: resp.description,
          schemaRef: jsonSchemaRef(resp.content),
        };
      });

      const list = groups.get(resource) ?? [];
      list.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        parameters,
        requestSchemaRef,
        responses,
      });
      groups.set(resource, list);
    }
  }

  return [...groups.entries()].map(([resource, operations]) => ({
    resource,
    operations,
  }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/openapi/model.test.ts`
Expected: PASS (all cases, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi/model.ts src/lib/openapi/model.test.ts
git commit -m "feat(openapi): group operations by resource with param/response resolution

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: API reference page + nav wiring + nav.test fix + rest-api link

**Files:**
- Create: `src/app/(marketing)/docs/api-reference/page.tsx`
- Modify: `src/lib/docs/nav.ts`
- Modify: `src/lib/docs/nav.test.ts`
- Modify: `src/app/(marketing)/docs/rest-api/page.mdx`

- [ ] **Step 1: Update nav.test.ts to accept a `.tsx` page (write the failing expectation)**

Replace the second test in `src/lib/docs/nav.test.ts` (the "every nav slug has a backing page.mdx" block, lines 15–23) with:

```ts
  it("every nav slug has a backing page", () => {
    for (const slug of DOC_SLUGS) {
      const dir = slug === "" ? DOCS_DIR : join(DOCS_DIR, slug);
      const hasPage =
        existsSync(join(dir, "page.mdx")) || existsSync(join(dir, "page.tsx"));
      expect(hasPage, `missing page for slug "${slug}"`).toBe(true);
    }
  });
```

- [ ] **Step 2: Add the nav entry**

In `src/lib/docs/nav.ts`, in the `Interfaces` section, add `api-reference` right after `rest-api`:

```ts
  {
    title: "Interfaces",
    links: [
      { slug: "cli", title: "CLI (ody)" },
      { slug: "rest-api", title: "REST API" },
      { slug: "api-reference", title: "API reference" },
      { slug: "mcp", title: "MCP server" },
    ],
  },
```

- [ ] **Step 3: Run the nav test to verify it FAILS (page not created yet)**

Run: `npx vitest run src/lib/docs/nav.test.ts`
Expected: FAIL — "missing page for slug \"api-reference\"" (the nav entry exists but the page does not).

- [ ] **Step 4: Create the reference page**

`src/app/(marketing)/docs/api-reference/page.tsx`:

```tsx
import type { Metadata } from "next";

import { spec } from "@/lib/openapi/spec";
import {
  getOperationGroups,
  getSchemas,
  type RenderedOperation,
} from "@/lib/openapi/model";

export const metadata: Metadata = {
  title: "API reference — Odyhook",
  description:
    "Full REST API reference for Odyhook, rendered from the OpenAPI spec: every endpoint, parameter, and schema.",
};

const BASE_URL = spec.servers?.[0]?.url ?? "https://odyhook.dev";
const groups = getOperationGroups(spec);
const schemas = getSchemas(spec);

function schemaAnchor(name: string): string {
  return `schema-${name.toLowerCase()}`;
}

function curlFor(op: RenderedOperation): string {
  const lines = [`curl -X ${op.method} ${BASE_URL}${op.path} \\`];
  lines.push(`  -H "Authorization: Bearer ody_…"`);
  if (["POST", "PATCH", "PUT"].includes(op.method) && op.requestSchemaRef) {
    lines[lines.length - 1] += ` \\`;
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{ … }'  # ${op.requestSchemaRef}`);
  }
  return lines.join("\n");
}

export default function ApiReferencePage() {
  return (
    <>
      <h1>API reference</h1>
      <p>{spec.info.description}</p>
      <p>
        Base URL: <code>{BASE_URL}</code> · Spec:{" "}
        <a href="/openapi.json">/openapi.json</a> (OpenAPI {spec.openapi})
      </p>
      <p>
        Every request authenticates with a bearer token (<code>ody_…</code>)
        minted at <strong>Settings → API Tokens</strong>. This page is generated
        from the OpenAPI spec, so it always matches the live contract. For{" "}
        <code>/api/v1/events/search</code> and <code>/api/v1/fixtures</code>, see{" "}
        the <a href="/docs/rest-api">REST API overview</a>.
      </p>

      {groups.map((group) => (
        <section key={group.resource}>
          <h2>{group.resource}</h2>
          {group.operations.map((op) => (
            <div key={`${op.method} ${op.path}`}>
              <h3>
                <code>
                  {op.method} {op.path}
                </code>
              </h3>
              {op.summary ? <p>{op.summary}</p> : null}
              {op.description ? <p>{op.description}</p> : null}

              {op.parameters.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      <th>In</th>
                      <th>Type</th>
                      <th>Required</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {op.parameters.map((p) => (
                      <tr key={`${p.in}-${p.name}`}>
                        <td>
                          <code>{p.name}</code>
                        </td>
                        <td>{p.in}</td>
                        <td>
                          <code>{p.type}</code>
                        </td>
                        <td>{p.required ? "yes" : "no"}</td>
                        <td>{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              {op.requestSchemaRef ? (
                <p>
                  Request body:{" "}
                  <a href={`#${schemaAnchor(op.requestSchemaRef)}`}>
                    <code>{op.requestSchemaRef}</code>
                  </a>
                </p>
              ) : null}

              <table>
                <thead>
                  <tr>
                    <th>Response</th>
                    <th>Description</th>
                    <th>Body</th>
                  </tr>
                </thead>
                <tbody>
                  {op.responses.map((r) => (
                    <tr key={r.status}>
                      <td>
                        <code>{r.status}</code>
                      </td>
                      <td>{r.description}</td>
                      <td>
                        {r.schemaRef ? (
                          <a href={`#${schemaAnchor(r.schemaRef)}`}>
                            <code>{r.schemaRef}</code>
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <pre>
                <code>{curlFor(op)}</code>
              </pre>
            </div>
          ))}
        </section>
      ))}

      <section>
        <h2>Schemas</h2>
        {schemas.map((s) => (
          <div key={s.name} id={schemaAnchor(s.name)}>
            <h3>
              <code>{s.name}</code>
            </h3>
            {s.description ? <p>{s.description}</p> : null}
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {s.fields.map((f) => (
                  <tr key={f.name}>
                    <td>
                      <code>{f.name}</code>
                      {f.readOnly ? " (read-only)" : ""}
                    </td>
                    <td>
                      <code>{f.type}</code>
                    </td>
                    <td>{f.required ? "yes" : "no"}</td>
                    <td>{f.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </>
  );
}
```

Note: this page lives under `src/app/(marketing)/docs/`, so it inherits
`docs/layout.tsx` (the `docs-prose` article wrapper + sidebar). That wrapper
already styles `h1/h2/h3/p/table/code/pre`, so no extra classes are needed.

- [ ] **Step 5: Add a link from the rest-api overview page**

In `src/app/(marketing)/docs/rest-api/page.mdx`, replace the final `## OpenAPI` paragraph with:

```mdx
## OpenAPI

A machine-readable OpenAPI specification is served at [/openapi.json](/openapi.json). Point your client generator or API explorer at it to get typed bindings for every endpoint above.

For a browsable, human-readable reference of every endpoint and schema, see the [API reference](/docs/api-reference).
```

- [ ] **Step 6: Run the nav test + typecheck**

Run: `npx vitest run src/lib/docs/nav.test.ts && npx tsc --noEmit`
Expected: nav test PASS (page now exists), tsc clean.

- [ ] **Step 7: Verify the page renders static in a build**

Run: `npm run build 2>&1 | grep -E "api-reference|Static|Dynamic"`
Expected: `○ /docs/api-reference` (Static). If it shows `ƒ`, something pulled in a dynamic API — re-check the page imports nothing request-time.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(marketing)/docs/api-reference/page.tsx" src/lib/docs/nav.ts src/lib/docs/nav.test.ts "src/app/(marketing)/docs/rest-api/page.mdx"
git commit -m "feat(docs): static API reference rendered from the OpenAPI spec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Competitor comparison data

**Files:**
- Create: `src/lib/marketing/comparisons.ts`
- Test: `src/lib/marketing/comparisons.test.ts`

All facts are as of **June 2026** with source links. Cells are `yes` / `no` /
`partial` with a short factual note.

- [ ] **Step 1: Write the failing test**

`src/lib/marketing/comparisons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { COMPARISONS, getComparison } from "./comparisons";

describe("comparison data", () => {
  it("has hookdeck and svix", () => {
    expect(COMPARISONS.map((c) => c.slug).sort()).toEqual(["hookdeck", "svix"]);
  });

  it("each comparison is fully populated", () => {
    for (const c of COMPARISONS) {
      expect(c.competitor.length).toBeGreaterThan(0);
      expect(c.asOf.length).toBeGreaterThan(0);
      expect(c.positioning.length).toBeGreaterThan(0);
      expect(c.features.length).toBeGreaterThan(5);
      expect(c.competitorStrengths.length).toBeGreaterThan(0);
      expect(c.pickOdyhookIf.length).toBeGreaterThan(0);
      expect(c.pickCompetitorIf.length).toBeGreaterThan(0);
      expect(c.sources.length).toBeGreaterThan(0);
    }
  });

  it("every feature row has both cells", () => {
    for (const c of COMPARISONS) {
      for (const row of c.features) {
        expect(row.capability.length).toBeGreaterThan(0);
        expect(["yes", "no", "partial"]).toContain(row.odyhook.value);
        expect(["yes", "no", "partial"]).toContain(row.competitor.value);
      }
    }
  });

  it("getComparison returns the matching record", () => {
    expect(getComparison("svix")?.competitor).toBe("Svix");
    expect(getComparison("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/marketing/comparisons.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`src/lib/marketing/comparisons.ts`:

```ts
// Competitor comparison data for /vs/hookdeck and /vs/svix.
// All claims verified as of June 2026 against the linked sources. Tone: factual,
// non-smug, competitor strengths stated plainly. When competitor facts change,
// update the cells, the prose, and the `asOf` stamp together.

export type CellValue = "yes" | "no" | "partial";
export type Cell = { value: CellValue; note?: string };
export type FeatureRow = {
  capability: string;
  odyhook: Cell;
  competitor: Cell;
};

export type Comparison = {
  slug: string;
  competitor: string;
  asOf: string;
  positioning: string;
  features: FeatureRow[];
  competitorStrengths: string[];
  pickOdyhookIf: string[];
  pickCompetitorIf: string[];
  sources: { label: string; url: string }[];
};

const yes = (note?: string): Cell => ({ value: "yes", note });
const no = (note?: string): Cell => ({ value: "no", note });
const partial = (note?: string): Cell => ({ value: "partial", note });

const hookdeck: Comparison = {
  slug: "hookdeck",
  competitor: "Hookdeck",
  asOf: "June 2026",
  positioning:
    "Hookdeck's Event Gateway is a hosted (SaaS) webhook gateway for receiving and routing events — the product that overlaps most with Odyhook. Its separate Outpost product (Apache-2.0, self-hostable) is for sending webhooks. Odyhook is a single self-hosted receiver/router you run on your own box for a flat cost, with BYOK AI built in. Hookdeck is more mature and has a far larger catalog of preconfigured sources and destinations; Odyhook trades that breadth for self-hosting, a flat bill, and AI-native tooling.",
  features: [
    {
      capability: "Self-hosted",
      odyhook: yes("You run it on your own server."),
      competitor: partial("Event Gateway is SaaS-only; Outpost (sending) is self-hostable."),
    },
    {
      capability: "Open source",
      odyhook: yes(),
      competitor: partial("Outpost is Apache-2.0; the Event Gateway is not."),
    },
    {
      capability: "Pricing model",
      odyhook: yes("Flat ~€6/mo: your server + BYOK, no per-event fees."),
      competitor: no("Free → $39/mo → $499/mo tiers plus per-event overage."),
    },
    {
      capability: "Inbound signature verification",
      odyhook: yes("Stripe, GitHub, generic SHA-256."),
      competitor: yes("Verifies provider signatures."),
    },
    {
      capability: "Outbound HMAC signing",
      odyhook: yes("Per-destination secret, signed headers."),
      competitor: yes(),
    },
    {
      capability: "Retries with backoff",
      odyhook: yes("10s → 30s → 2m → 10m → 1h → 6h."),
      competitor: yes("Durable queue with retries."),
    },
    {
      capability: "Idempotency / dedup",
      odyhook: yes("Per-source idempotency key."),
      competitor: yes("Field-based deduplication."),
    },
    {
      capability: "Filtering",
      odyhook: yes("JSONPath + AI-compiled filters."),
      competitor: yes("Advanced filtering."),
    },
    {
      capability: "Transformations",
      odyhook: yes("Sandboxed JS (QuickJS)."),
      competitor: yes("Transformations."),
    },
    {
      capability: "Replay",
      odyhook: yes("Single + bulk replay."),
      competitor: yes(),
    },
    {
      capability: "Local-dev forwarding (CLI)",
      odyhook: yes("ody listen streams events to localhost."),
      competitor: yes("Hookdeck CLI forwards to localhost."),
    },
    {
      capability: "MCP / AI-agent tools",
      odyhook: yes("Stateless MCP server over the API."),
      competitor: partial("Markets MCP & Agent Skills."),
    },
    {
      capability: "BYOK AI (filters, diagnosis, NL search, diffs)",
      odyhook: yes("Bring your own Anthropic key."),
      competitor: no(),
    },
    {
      capability: "Preconfigured source catalog",
      odyhook: no("Generic sources; you configure them."),
      competitor: yes("120+ preconfigured sources."),
    },
    {
      capability: "Non-HTTP destinations (Kafka/SQS/…)",
      odyhook: no("HTTPS destinations only."),
      competitor: yes("Via Outpost: SQS, Kafka, Pub/Sub, etc."),
    },
    {
      capability: "Enterprise compliance (SOC 2 / SSO / SLA)",
      odyhook: no("Solo self-hosted; no compliance program."),
      competitor: yes("SOC 2; SSO/SAML/SCIM + SLAs on higher tiers."),
    },
  ],
  competitorStrengths: [
    "120+ preconfigured sources and a broad destination catalog (incl. Kafka/SQS via Outpost).",
    "Enterprise compliance: SOC 2, SSO/SAML/SCIM, uptime/latency SLAs.",
    "A mature, fully managed service — nothing to operate.",
    "Visual tracing, full-text search, and issue tracking out of the box.",
  ],
  pickOdyhookIf: [
    "You want to self-host and keep webhook data on your own infrastructure.",
    "You want a flat, predictable bill instead of per-event pricing.",
    "You want AI-native filtering, diagnosis, and search with your own Anthropic key.",
  ],
  pickCompetitorIf: [
    "You need a managed service with enterprise compliance (SOC 2, SSO, SLAs).",
    "You need a large catalog of preconfigured sources or non-HTTP destinations.",
    "You'd rather not operate any infrastructure yourself.",
  ],
  sources: [
    { label: "Hookdeck pricing", url: "https://hookdeck.com/pricing" },
    { label: "Hookdeck Outpost (open source)", url: "https://github.com/hookdeck/outpost" },
  ],
};

const svix: Comparison = {
  slug: "svix",
  competitor: "Svix",
  asOf: "June 2026",
  positioning:
    "Svix is an open-source (MIT) webhooks service focused on sending webhooks — it helps a SaaS deliver events to its own customers, with an embeddable customer-facing portal as its flagship. Odyhook solves the other side: receiving webhooks from providers and routing them to your destinations, self-hosted, with BYOK AI. Both can be self-hosted, but they target different jobs. If you're building a product that sends webhooks to your users, Svix is purpose-built for that; if you're routing inbound webhooks for yourself, Odyhook fits better.",
  features: [
    {
      capability: "Self-hosted",
      odyhook: yes("You run it on your own server."),
      competitor: yes("MIT server self-hostable; portal UI is SaaS-only."),
    },
    {
      capability: "Open source",
      odyhook: yes(),
      competitor: yes("MIT-licensed server."),
    },
    {
      capability: "Pricing model (SaaS)",
      odyhook: yes("Flat ~€6/mo: your server + BYOK."),
      competitor: no("Free → $490/mo → custom, per attempted message."),
    },
    {
      capability: "Primary direction",
      odyhook: yes("Receive & route inbound webhooks."),
      competitor: partial("Built to send webhooks to your users."),
    },
    {
      capability: "Inbound signature verification",
      odyhook: yes("Stripe, GitHub, generic SHA-256."),
      competitor: partial("Verification is on the consumer side of its sending model."),
    },
    {
      capability: "Outbound HMAC signing",
      odyhook: yes(),
      competitor: yes("Signs outgoing messages."),
    },
    {
      capability: "Retries with backoff",
      odyhook: yes("10s → 30s → 2m → 10m → 1h → 6h."),
      competitor: yes(),
    },
    {
      capability: "Filtering",
      odyhook: yes("JSONPath + AI-compiled filters."),
      competitor: yes("Event-type filtering."),
    },
    {
      capability: "Transformations",
      odyhook: yes("Sandboxed JS (QuickJS)."),
      competitor: yes("Transformations."),
    },
    {
      capability: "Replay",
      odyhook: yes("Single + bulk replay."),
      competitor: yes("Recover/replay failed messages."),
    },
    {
      capability: "Embeddable customer portal",
      odyhook: no("Not a sender product; no end-user portal."),
      competitor: yes("Flagship embeddable app portal (SaaS)."),
    },
    {
      capability: "Local-dev forwarding (CLI)",
      odyhook: yes("ody listen streams events to localhost."),
      competitor: partial("Svix Play test inbox; no localhost-forwarding CLI."),
    },
    {
      capability: "MCP / AI-agent tools",
      odyhook: yes("Stateless MCP server over the API."),
      competitor: no(),
    },
    {
      capability: "BYOK AI (filters, diagnosis, NL search, diffs)",
      odyhook: yes("Bring your own Anthropic key."),
      competitor: no(),
    },
    {
      capability: "Enterprise compliance (SOC 2 / SSO / SLA)",
      odyhook: no("Solo self-hosted; no compliance program."),
      competitor: yes("SOC 2 Type II, SSO, on-prem, 99.99–99.999% SLAs."),
    },
  ],
  competitorStrengths: [
    "Purpose-built for sending webhooks to your own users, with an embeddable portal.",
    "Mature, MIT-licensed Rust server with a well-documented API and SDKs.",
    "Enterprise tier: SOC 2 Type II, SSO, on-prem, audit logs, high SLAs.",
    "Generous free SaaS tier (50k attempted messages/mo).",
  ],
  pickOdyhookIf: [
    "You're receiving and routing inbound webhooks rather than sending them to customers.",
    "You want a flat self-hosted bill and BYOK AI tooling.",
    "You want one box to ingest, verify, filter, transform, and forward.",
  ],
  pickCompetitorIf: [
    "You're a SaaS that needs to send webhooks to your customers.",
    "You want an embeddable, white-label customer portal.",
    "You need enterprise compliance (SOC 2, SSO, on-prem, high SLAs).",
  ],
  sources: [
    { label: "Svix pricing", url: "https://www.svix.com/pricing/" },
    { label: "Svix open-source server", url: "https://github.com/svix/svix-webhooks" },
  ],
};

export const COMPARISONS: Comparison[] = [hookdeck, svix];

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/marketing/comparisons.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/comparisons.ts src/lib/marketing/comparisons.test.ts
git commit -m "feat(marketing): verified, datestamped Hookdeck/Svix comparison data

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: ComparisonPage component + route pages + pricing links

**Files:**
- Create: `src/components/marketing/comparison-page.tsx`
- Create: `src/app/(marketing)/vs/hookdeck/page.tsx`
- Create: `src/app/(marketing)/vs/svix/page.tsx`
- Modify: `src/app/(marketing)/pricing/page.tsx`

- [ ] **Step 1: Create the shared renderer**

`src/components/marketing/comparison-page.tsx`:

```tsx
import type { Comparison, CellValue } from "@/lib/marketing/comparisons";

const MARK: Record<CellValue, string> = {
  yes: "✓",
  no: "—",
  partial: "~",
};

export function ComparisonPage({ data }: { data: Comparison }) {
  return (
    <>
      <h1 className="marketing-h1">Odyhook vs {data.competitor}</h1>
      <p className="marketing-lede">{data.positioning}</p>
      <p className="marketing-lede" style={{ fontSize: "0.85rem", opacity: 0.7 }}>
        Comparison as of {data.asOf}. {data.competitor} facts are sourced below;
        they may change — check the linked pages for the latest.
      </p>

      <div className="docs-prose" style={{ marginTop: "2rem" }}>
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Odyhook</th>
              <th>{data.competitor}</th>
            </tr>
          </thead>
          <tbody>
            {data.features.map((row) => (
              <tr key={row.capability}>
                <td>{row.capability}</td>
                <td>
                  {MARK[row.odyhook.value]}
                  {row.odyhook.note ? ` ${row.odyhook.note}` : ""}
                </td>
                <td>
                  {MARK[row.competitor.value]}
                  {row.competitor.note ? ` ${row.competitor.note}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="marketing-h1" style={{ fontSize: "1.5rem", marginTop: "2.5rem" }}>
        Where {data.competitor} is stronger
      </h2>
      <ul className="docs-prose">
        {data.competitorStrengths.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "2rem",
          marginTop: "2.5rem",
        }}
      >
        <div>
          <h2 className="marketing-h1" style={{ fontSize: "1.25rem" }}>
            Pick Odyhook if
          </h2>
          <ul className="docs-prose">
            {data.pickOdyhookIf.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="marketing-h1" style={{ fontSize: "1.25rem" }}>
            Pick {data.competitor} if
          </h2>
          <ul className="docs-prose">
            {data.pickCompetitorIf.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>

      <p className="marketing-lede" style={{ fontSize: "0.85rem", marginTop: "2.5rem" }}>
        Sources:{" "}
        {data.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 ? " · " : ""}
            <a href={s.url}>{s.label}</a>
          </span>
        ))}
      </p>
    </>
  );
}
```

- [ ] **Step 2: Create the two route pages**

`src/app/(marketing)/vs/hookdeck/page.tsx`:

```tsx
import type { Metadata } from "next";

import { ComparisonPage } from "@/components/marketing/comparison-page";
import { getComparison } from "@/lib/marketing/comparisons";

const data = getComparison("hookdeck")!;

export const metadata: Metadata = {
  title: "Odyhook vs Hookdeck — webhook routing compared",
  description:
    "An honest, sourced comparison of Odyhook (self-hosted, flat-cost, BYOK AI) and Hookdeck's Event Gateway. Where each one fits.",
};

export default function VsHookdeckPage() {
  return <ComparisonPage data={data} />;
}
```

`src/app/(marketing)/vs/svix/page.tsx`:

```tsx
import type { Metadata } from "next";

import { ComparisonPage } from "@/components/marketing/comparison-page";
import { getComparison } from "@/lib/marketing/comparisons";

const data = getComparison("svix")!;

export const metadata: Metadata = {
  title: "Odyhook vs Svix — webhook routing compared",
  description:
    "An honest, sourced comparison of Odyhook (self-hosted inbound router, BYOK AI) and Svix (open-source webhook sending). Where each one fits.",
};

export default function VsSvixPage() {
  return <ComparisonPage data={data} />;
}
```

- [ ] **Step 3: Link the comparison pages from /pricing**

In `src/app/(marketing)/pricing/page.tsx`, add a `Link` import is already present. Add this block just before the closing `</>` (after the "Deploy your own" button `<div>`):

```tsx
      <p className="marketing-lede" style={{ marginTop: "2.5rem", fontSize: "0.9rem" }}>
        Compare: <Link href="/vs/hookdeck">vs Hookdeck</Link> ·{" "}
        <Link href="/vs/svix">vs Svix</Link>
      </p>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Verify the pages render static**

Run: `npm run build 2>&1 | grep -E "/vs/|Static|Dynamic"`
Expected: `○ /vs/hookdeck` and `○ /vs/svix` (Static).

- [ ] **Step 6: Commit**

```bash
git add "src/components/marketing/comparison-page.tsx" "src/app/(marketing)/vs" "src/app/(marketing)/pricing/page.tsx"
git commit -m "feat(marketing): /vs/hookdeck and /vs/svix comparison pages

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Final verification

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all pass, including the new `model.test.ts`, `comparisons.test.ts`, and the updated `nav.test.ts`.

- [ ] **Step 3: Build + confirm all new routes are static**

Run: `npm run build 2>&1 | grep -E "api-reference|/vs/"`
Expected: `○ /docs/api-reference`, `○ /vs/hookdeck`, `○ /vs/svix`.

- [ ] **Step 4: Pre-push infra-check (docs drift)**

The marketing surface grew (new `/docs/api-reference` and `/vs/*` routes). Run the
`infra-check` skill against the diff and apply any doc fix it proposes to
`infra/README.md` (the "what this project is" paragraph lists public routes).

- [ ] **Step 5: Push and open a PR**

```bash
git push -u origin feat/api-reference-and-comparison-pages
gh pr create --base main --title "feat: API reference page + Hookdeck/Svix comparison pages" --body "<summary>"
```

---

## Self-review notes

- **Spec coverage:** Part A (renderer Tasks 2–3, page+nav+link Task 4) and Part B
  (data Task 5, component+routes+pricing Task 6) both covered. Static requirement
  verified in Tasks 4/6/7. Tests for both logic surfaces (Tasks 2/3/5) + nav.
- **Type consistency:** `RenderedOperation`, `OperationGroup`, `RenderedSchema`,
  `Comparison`, `Cell`, `CellValue` names are used identically across model,
  page, data, and component tasks.
- **Known check:** if `npm run build` marks any new route `ƒ`, a request-time
  import sneaked in — the page modules must only import the static `spec`,
  `model`, and `comparisons` (no `auth()`/cookies/headers).
- **Competitor accuracy:** the one cell carrying mild uncertainty (Svix
  local-dev) is framed conservatively ("Svix Play test inbox; no
  localhost-forwarding CLI") and the whole page is datestamped + sourced.
```
