// Next.js loads this file once per process. We branch by runtime so that
// the Node SDK isn't pulled into Edge bundles and vice versa.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast if a placeholder secret slipped into a production deploy.
    const { assertProdSecrets } = await import("./lib/env-check");
    assertProdSecrets();
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs";
