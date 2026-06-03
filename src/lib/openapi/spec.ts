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
