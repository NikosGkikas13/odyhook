"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/use-cases", label: "Use cases" },
  { href: "/pricing", label: "Pricing" },
  { href: "/changelog", label: "Changelog" },
];

export function MarketingHeader({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  return (
    <header className="marketing-header">
      <Link href="/" className="font-semibold">
        Odyhook
      </Link>
      <nav className="marketing-header-nav">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
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
      <span className="marketing-header-spacer" />
      <Link
        href={signedIn ? "/sources" : "/signin"}
        className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
      >
        {signedIn ? "Dashboard" : "Sign in"}
      </Link>
    </header>
  );
}
