import { auth } from "@/auth";

import { DeleteAccountForm } from "./delete-account-form";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;
  const email = session.user.email;

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Export your data, or permanently delete your account. Signed in as{" "}
          <strong>{email}</strong>.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Export your data</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Download a JSON copy of your account, sources, destinations, routes,
          events, and deliveries. Encrypted secrets (signing secrets,
          destination headers, your Anthropic key) are not included.
        </p>
        <a
          href="/api/account/export"
          className="btn-primary-ody mt-4 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
        >
          Download my data
        </a>
      </section>

      <section className="rounded-lg border border-red-200 bg-white p-4 sm:p-6 dark:border-red-900/50 dark:bg-zinc-900">
        <h2 className="text-sm font-medium text-red-700 dark:text-red-400">
          Delete account
        </h2>
        <p className="mt-2 text-sm text-zinc-500">
          Permanently deletes your account and{" "}
          <strong>all associated data</strong> — sources, destinations, routes,
          events, deliveries, API tokens, and keys. This cannot be undone.
        </p>
        <DeleteAccountForm email={email} />
      </section>
    </div>
  );
}
