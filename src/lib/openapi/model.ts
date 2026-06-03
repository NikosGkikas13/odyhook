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
