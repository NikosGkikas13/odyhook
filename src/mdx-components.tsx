import type { MDXComponents } from "mdx/types";
import Link from "next/link";

import { Callout } from "@/components/docs/callout";
import { CodeTabs } from "@/components/docs/code-tabs";

// Global MDX component map (Next 16 file convention — useMDXComponents takes
// no args). Styling rides on the .docs-prose block in globals.css; we only
// override <a> to use next/link for internal hrefs and expose the custom
// Callout / CodeTabs components so .mdx files can use them without importing.
const components: MDXComponents = {
  a: ({ href = "", children, ...rest }) => {
    const isInternal = href.startsWith("/") || href.startsWith("#");
    if (isInternal) {
      return (
        <Link href={href} {...rest}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  Callout,
  CodeTabs,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
