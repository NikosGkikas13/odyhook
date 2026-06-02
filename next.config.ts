import { withSentryConfig } from "@sentry/nextjs";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let .mdx files act as routes/pages.
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
  turbopack: {
    // Pin the workspace root to this project so Turbopack doesn't pick up
    // an outer lockfile at ~/package-lock.json.
    root: process.cwd(),
  },
};

// Plugins are passed as STRING names because this project runs Turbopack,
// which cannot serialize imported plugin functions to its Rust core. Options
// must stay serializable (strings/booleans/objects only). See
// node_modules/next/dist/docs/01-app/02-guides/mdx.md.
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: [
      "rehype-slug",
      [
        "rehype-pretty-code",
        {
          theme: "github-dark-dimmed",
          // Our .docs-prose CSS owns the code-block background.
          keepBackground: false,
        },
      ],
    ],
  },
});

// withSentryConfig also handles route-instrumentation; org/project are
// omitted intentionally — source-map upload would require an auth token
// we don't have yet. MDX wraps the base config; Sentry stays outermost.
export default withSentryConfig(withMDX(nextConfig), {
  silent: true,
});
