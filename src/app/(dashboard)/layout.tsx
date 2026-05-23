import Image from "next/image";
import Link from "next/link";

import { auth, signOut } from "@/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { NavLinks } from "@/components/nav-links";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
          <Link href="/sources" className="flex items-center gap-2">
            <span className="flex items-center rounded bg-white p-0.5 dark:bg-white">
              <Image
                src="/odyhook-logo.png"
                alt="Odyhook"
                width={26}
                height={26}
                className="block"
              />
            </span>
            <span
              className="text-[18px] font-[800] leading-none tracking-[-0.02em]"
              style={{ fontFamily: "var(--font-brand)" }}
            >
              <span style={{ color: "var(--brand-navy)" }} className="dark:text-zinc-100">ody</span>
              <span style={{ color: "var(--brand-blue)" }}>hook</span>
            </span>
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-3 text-sm text-zinc-500">
            <span>{session?.user?.email}</span>
            <ThemeToggle />
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
