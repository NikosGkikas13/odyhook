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
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
        <div className="mx-auto max-w-7xl px-3 sm:px-6">
          <div className="flex h-14 items-center gap-3 sm:gap-6">
            <Link href="/sources" className="flex shrink-0 items-center gap-2">
              <Image
                src="/c60f052d-1a1f-461a-9527-c782a250f441__1_-removebg-preview.png"
                style={{
                  background: "white",
                  borderRadius: "5px",
                  padding: "2px",
                }}
                alt=""
                width={40}
                height={40}
                unoptimized
              />
              <span className="brand-wordmark hidden xl:inline-flex">
                <span className="ody">ody</span>
                <span className="hook">hook</span>
              </span>
            </Link>
            <div className="hidden min-w-0 flex-1 sm:block">
              <NavLinks />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 text-sm text-zinc-500 sm:gap-3">
              <span className="hidden max-w-[180px] truncate md:inline lg:max-w-[260px]">
                {session?.user?.email}
              </span>
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
          <div className="-mx-3 border-t border-zinc-100 dark:border-zinc-800 sm:hidden">
            <div className="overflow-x-auto px-3 py-2">
              <NavLinks />
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
