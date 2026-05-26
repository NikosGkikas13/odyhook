import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseStoredConfig } from "@/lib/alerts/config";
import { saveUserAlerts, sendTestAlert } from "@/lib/actions/alerts";
import { DEFAULT_ALERT_CONFIG } from "@/lib/alerts/schema";

export const dynamic = "force-dynamic";

export default async function AlertsSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { email: true, alertConfigJson: true },
  });
  const cfg = parseStoredConfig(user.alertConfigJson) ?? DEFAULT_ALERT_CONFIG;

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure how Odyhook notifies you when a destination is unhealthy.
          These are account-wide defaults; any destination can override them
          on its own page.
        </p>
      </div>

      <form action={saveUserAlerts} className="space-y-6">
        {/* Email */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium">Email</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Sent to <span className="font-mono">{user.email}</span>.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.email.enabled"
                defaultChecked={!!cfg.channels?.email?.enabled}
              />
              Enabled
            </label>
          </div>
        </section>

        {/* Slack */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-medium">Slack incoming webhook</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.slack.enabled"
                defaultChecked={!!cfg.channels?.slack?.enabled}
              />
              Enabled
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Webhook URL</span>
            <input
              name="channel.slack.url"
              type="url"
              placeholder="https://hooks.slack.com/services/T000/B000/abcdef"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <p className="mt-2 text-xs text-zinc-500">
            URL is stored encrypted and never shown again. Re-enter it to update.
          </p>
        </section>

        {/* Generic webhook */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-medium">Generic webhook</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.webhook.enabled"
                defaultChecked={!!cfg.channels?.webhook?.enabled}
              />
              Enabled
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">URL (https only)</span>
            <input
              name="channel.webhook.url"
              type="url"
              placeholder="https://hooks.example.com/odyhook"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Headers (JSON object, optional)
            </span>
            <textarea
              name="channel.webhook.headers"
              rows={3}
              placeholder={`{"X-Api-Key": "..."}`}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </section>

        {/* Triggers */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Triggers</h2>

          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="trigger.exhausted.enabled"
              defaultChecked={!!cfg.triggers?.exhausted?.enabled}
            />
            <span>
              <strong>Exhausted delivery</strong> — fire when a delivery uses up all
              retries.
            </span>
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.failureRate.enabled"
                defaultChecked={!!cfg.triggers?.failureRate?.enabled}
              />
              <strong>High failure rate</strong> — fire when
            </label>
            <input
              name="trigger.failureRate.ratePct"
              type="number"
              min={1}
              max={100}
              defaultValue={cfg.triggers?.failureRate?.ratePct ?? 50}
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>% of the last</span>
            <input
              name="trigger.failureRate.windowCount"
              type="number"
              min={2}
              max={200}
              defaultValue={cfg.triggers?.failureRate?.windowCount ?? 20}
              className="h-8 w-24 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>deliveries failed.</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.firstFailure.enabled"
                defaultChecked={!!cfg.triggers?.firstFailure?.enabled}
              />
              <strong>First failure after recovery</strong> — fire on the next
              failure after
            </label>
            <input
              name="trigger.firstFailure.afterSuccessCount"
              type="number"
              min={1}
              max={50}
              defaultValue={cfg.triggers?.firstFailure?.afterSuccessCount ?? 5}
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>consecutive successes.</span>
          </div>
        </section>

        {/* Cooldown */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Cooldown (minutes between alerts of the same kind on the same destination)
            </span>
            <input
              name="cooldownMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={cfg.cooldownMinutes ?? 15}
              className="h-9 w-32 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </section>

        <button
          type="submit"
          className="h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Save alert settings
        </button>
      </form>

      {/* Test buttons live in a separate form so submitting one doesn't
          carry every other field's value. */}
      <section className="rounded-lg border border-dashed border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Send test alert</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Fires a sample alert through the channel — bypasses cooldown.
          Save your config first.
        </p>
        <div className="mt-3 flex gap-2">
          {(["email", "slack", "webhook"] as const).map((ch) => (
            <form key={ch} action={sendTestAlert}>
              <input type="hidden" name="channel" value={ch} />
              <button
                type="submit"
                className="h-8 rounded-md border border-zinc-300 bg-white px-3 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              >
                Test {ch}
              </button>
            </form>
          ))}
        </div>
      </section>
    </div>
  );
}
