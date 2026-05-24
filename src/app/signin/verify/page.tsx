export default async function VerifyRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 sm:py-16">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-sm sm:p-8 dark:border-zinc-700 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold tracking-tight">
          Check your email
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {email ? (
            <>
              A sign-in link has been sent to{" "}
              <strong className="text-zinc-900 dark:text-zinc-100">
                {email}
              </strong>
              .
            </>
          ) : (
            "A sign-in link has been sent to your email address."
          )}
        </p>
        <p className="mt-3 text-xs text-zinc-500">
          Click the link in the email to finish signing in. The link expires in
          24 hours.
        </p>
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
            </a>
            .
          </p>
        )}
      </div>
    </main>
  );
}
