import { describe, it, expect } from "vitest";
import { spec } from "./spec";
import {
  refName,
  resolveRef,
  formatType,
  getSchemas,
  getOperationGroups,
} from "./model";

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
