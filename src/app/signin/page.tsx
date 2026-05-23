import { redirect } from "next/navigation";
import Image from "next/image";

import { signIn } from "@/auth";

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex items-center rounded bg-white p-0.5 shadow-sm">
            <Image src="/odyhook-logo.png" alt="Odyhook" width={28} height={28} />
          </span>
          <span
            className="text-[20px] font-[800] leading-none tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-brand)" }}
          >
            <span style={{ color: "var(--brand-navy)" }}>ody</span>
            <span style={{ color: "var(--brand-blue)" }}>hook</span>
          </span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          Sign in
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Continue with GitHub, or get a magic link by email.
        </p>
        <SignInForm searchParams={searchParams} />
        {process.env.NODE_ENV !== "production" && (
          <p className="mt-6 text-xs text-zinc-500">
            Local dev: check MailHog at{" "}
            <a
              href="http://localhost:8025"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              localhost:8025
            </a>{" "}
            for the magic link.
          </p>
        )}
      </div>
    </main>
  );
}

async function SignInForm({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const redirectTo = callbackUrl ?? "/sources";
  return (
    <div className="mt-6 space-y-4">
      <form
        action={async () => {
          "use server";
          await signIn("github", { redirectTo });
        }}
      >
        <button
          type="submit"
          className="inline-flex h-10 w-full items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Continue with GitHub
        </button>
      </form>
      <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-zinc-500">
        <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        or
        <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <form
        action={async (formData: FormData) => {
          "use server";
          const email = String(formData.get("email"));
          await signIn("nodemailer", {
            email,
            redirect: false,
            redirectTo,
          });
          redirect(`/signin/verify?email=${encodeURIComponent(email)}`);
        }}
        className="space-y-3"
      >
        <input
          name="email"
          type="email"
          required
          placeholder="you@example.com"
          className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
        />
        <button
          type="submit"
          style={{ background: "var(--brand-navy)" }}
          className="inline-flex h-10 w-full items-center justify-center rounded-md px-4 text-sm font-medium text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Send magic link
        </button>
        {error && (
          <p className="text-xs text-red-600">Sign-in error: {error}</p>
        )}
      </form>
    </div>
  );
}
