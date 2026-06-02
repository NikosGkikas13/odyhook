"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { DOCS_NAV, hrefForSlug } from "@/lib/docs/nav";

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <aside className="docs-sidebar">
      {DOCS_NAV.map((section) => (
        <div key={section.title} className="docs-sidebar-section">
          <h4>{section.title}</h4>
          {section.links.map((link) => {
            const href = hrefForSlug(link.slug);
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={active ? "is-active" : undefined}
              >
                {link.title}
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
