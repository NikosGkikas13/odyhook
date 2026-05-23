"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/sources", label: "Sources" },
  { href: "/events", label: "Events" },
  { href: "/destinations", label: "Destinations" },
  { href: "/routes", label: "Routes" },
  { href: "/settings/api-keys", label: "Settings" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-4 text-sm">
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            style={
              active
                ? {
                    color: "var(--brand-navy)",
                    borderBottom: "2px solid var(--brand-blue)",
                    paddingBottom: "2px",
                  }
                : undefined
            }
            className={
              active
                ? "font-medium"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
