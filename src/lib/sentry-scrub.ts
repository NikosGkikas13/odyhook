// Shared Sentry data scrubbing. Sentry was initialised without beforeSend, so
// exceptions thrown deep in ingest/worker could attach request context (body,
// headers, cookies) — potentially capturing secret-shaped data. This strips the
// request body, cookies, query string, and sensitive headers before send.
//
// Used by sentry.server.config, sentry.edge.config, and the worker's inline init
// (all also set sendDefaultPii: false).

const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|x-api-key|x-signature|stripe-signature|x-hub-signature|ody[-_])/i;

type ScrubbableEvent = {
  request?: {
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
    headers?: Record<string, unknown>;
  };
};

export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  const req = event.request;
  if (req) {
    delete req.data; // request body
    delete req.cookies;
    delete req.query_string; // may carry tokens
    if (req.headers) {
      for (const key of Object.keys(req.headers)) {
        if (SENSITIVE_HEADER_RE.test(key)) delete req.headers[key];
      }
    }
  }
  return event;
}
