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
