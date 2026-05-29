"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/overview", label: "Overview" },
  { href: "/sources", label: "Sources" },
  { href: "/events", label: "Events" },
  { href: "/destinations", label: "Destinations" },
  { href: "/routes", label: "Routes" },
  { href: "/settings/api-keys", label: "Settings" },
  { href: "/settings/alerts", label: "Alerts" },
  { href: "/settings/api-tokens", label: "API Tokens" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-4 whitespace-nowrap text-sm">
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            style={
              active
                ? {
                    borderBottom: "2px solid var(--brand-blue-fg)",
                    paddingBottom: "2px",
                  }
                : undefined
            }
            className={
              active
                ? "font-medium text-zinc-900 dark:text-zinc-100"
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
