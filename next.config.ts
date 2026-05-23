import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root to this project so Turbopack doesn't pick up
    // an outer lockfile at ~/package-lock.json.
    root: process.cwd(),
  },
};

// withSentryConfig also handles route-instrumentation; org/project are
// omitted intentionally — source-map upload would require an auth token
// we don't have yet.
export default withSentryConfig(nextConfig, {
  silent: true,
});
