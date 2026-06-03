import {
  spec as defaultSpec,
  type JsonSchema,
  type OpenApiSpec,
  type Operation,
  type Parameter,
  type PathItem,
  type Response,
} from "./spec";

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
