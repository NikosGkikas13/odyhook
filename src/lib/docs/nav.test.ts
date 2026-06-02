import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DOC_SLUGS } from "./nav";

const DOCS_DIR = join(process.cwd(), "src", "app", "(marketing)", "docs");

describe("docs nav", () => {
  it("has no duplicate slugs", () => {
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
  });

  it("every nav slug has a backing page.mdx", () => {
    for (const slug of DOC_SLUGS) {
      const file =
        slug === ""
          ? join(DOCS_DIR, "page.mdx")
          : join(DOCS_DIR, slug, "page.mdx");
      expect(existsSync(file), `missing page.mdx for slug "${slug}"`).toBe(true);
    }
  });
});
