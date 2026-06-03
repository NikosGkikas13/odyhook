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
