"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/use-cases", label: "Use cases" },
  { href: "/changelog", label: "Changelog" },
];

export function MarketingHeader() {
  const pathname = usePathname();
  // Read the session on the client so the marketing layout stays static
  // (prerendered). Until it resolves we optimistically show the signed-out
  // CTA, which is the right default for a public docs site and matches the
  // server-prerendered HTML (no hydration mismatch).
  const { data: session } = useSession();
  const signedIn = !!session?.user;
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
