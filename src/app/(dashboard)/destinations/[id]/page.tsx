import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseStoredConfig, mergeAlertConfigs } from "@/lib/alerts/config";
import { saveDestinationAlerts } from "@/lib/actions/alerts";
import {
  getLatency,
  getSuccessRate,
  getThroughput,
} from "@/lib/metrics/queries";
import { DEFAULT_SINCE, SINCE_VALUES, type SinceWindow } from "@/lib/metrics/types";

import { ChartCard } from "@/components/metrics/chart-card";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { RefreshButton } from "@/components/metrics/refresh-button";
import { SuccessRateChart } from "@/components/metrics/success-rate-chart";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { TimeWindowSelector } from "@/components/metrics/time-window-selector";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export default async function DestinationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ since?: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const { since: rawSince } = await searchParams;
  const since: SinceWindow =
    rawSince && SINCE_VALUES.has(rawSince as SinceWindow)
      ? (rawSince as SinceWindow)
      : DEFAULT_SINCE;

  const dest = await prisma.destination.findFirst({
    where: { id, userId: session.user.id },
    select: {
      id: true,
      name: true,
      url: true,
      enabled: true,
      alertConfigJson: true,
      user: { select: { email: true, alertConfigJson: true } },
    },
  });
  if (!dest) notFound();

  const [throughput, successRate, latency] = await Promise.all([
    getThroughput({ userId: session.user.id, since, destinationId: id }),
    getSuccessRate({ userId: session.user.id, since, destinationId: id }),
    getLatency({ userId: session.user.id, since, destinationId: id }),
  ]);

  const userCfg = parseStoredConfig(dest.user.alertConfigJson);
  const destCfg = parseStoredConfig(dest.alertConfigJson);
  const usingDefaults = destCfg === null;
  const effective = mergeAlertConfigs(userCfg, destCfg);

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/destinations"
          className="text-sm text-zinc-500 hover:underline"
        >
          ← Destinations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{dest.name}</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">{dest.url}</p>
      </div>

      <section className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          <TimeWindowSelector basePath={`/destinations/${dest.id}`} active={since} />
          <RefreshButton />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Throughput" subtitle="Events forwarded to this destination">
            <ThroughputChart data={throughput} />
          </ChartCard>
          <ChartCard title="Success rate" subtitle="Delivered ÷ (delivered + failed)">
            <SuccessRateChart data={successRate} />
          </ChartCard>
          <ChartCard title="Delivery latency" subtitle="p50 (solid) / p95 (dashed)">
            <LatencyChart data={latency} />
          </ChartCard>
        </div>
      </section>

      <form action={saveDestinationAlerts} className="max-w-3xl space-y-6">
        <input type="hidden" name="destinationId" value={dest.id} />

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Alerts</h2>
          <div className="mt-3 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="useDefaults"
                defaultChecked={usingDefaults}
              />
              <span>Use account defaults (configured at <Link href="/settings/alerts" className="underline">Settings → Alerts</Link>)</span>
            </label>
            <p className="text-xs text-zinc-500">
              When checked, this destination inherits your account-wide alert
              settings. Uncheck to override below.
            </p>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Channels for this destination</h2>

          <div className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.email.enabled"
                defaultChecked={!!effective.channels?.email?.enabled}
              />
              Email → <span className="font-mono text-xs">{dest.user.email}</span>
            </label>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="channel.slack.enabled"
                  defaultChecked={!!effective.channels?.slack?.enabled}
                />
                Slack webhook URL
              </label>
              {effective.channels?.slack?.webhookUrlEnc ? (
                <p className="text-xs text-emerald-600">
                  ✓ URL saved. Leave blank to keep it; type a new URL to replace.
                </p>
              ) : null}
              <input
                name="channel.slack.url"
                type="url"
                placeholder="https://hooks.slack.com/services/..."
                aria-label="Slack webhook URL"
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="channel.webhook.enabled"
                  defaultChecked={!!effective.channels?.webhook?.enabled}
                />
                Generic webhook URL
              </label>
              {effective.channels?.webhook?.urlEnc ? (
                <p className="text-xs text-emerald-600">
                  ✓ URL saved. Leave blank to keep the existing URL and headers.
                </p>
              ) : null}
              <input
                name="channel.webhook.url"
                type="url"
                placeholder="https://hooks.example.com/odyhook"
                aria-label="Generic webhook URL"
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
              <textarea
                name="channel.webhook.headers"
                rows={3}
                placeholder={`{"X-Api-Key": "..."}`}
                aria-label="Generic webhook headers (JSON object)"
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Triggers</h2>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="trigger.exhausted.enabled"
              defaultChecked={!!effective.triggers?.exhausted?.enabled}
            />
            Exhausted delivery
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.failureRate.enabled"
                defaultChecked={!!effective.triggers?.failureRate?.enabled}
              />
              Failure rate
            </label>
            <input
              name="trigger.failureRate.ratePct"
              type="number"
              min={1}
              max={100}
              defaultValue={effective.triggers?.failureRate?.ratePct ?? 50}
              aria-label="Failure rate threshold (percent)"
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>% over last</span>
            <input
              name="trigger.failureRate.windowCount"
              type="number"
              min={2}
              max={200}
              defaultValue={effective.triggers?.failureRate?.windowCount ?? 20}
              aria-label="Window size (recent deliveries to evaluate)"
              className="h-8 w-24 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>deliveries</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.firstFailure.enabled"
                defaultChecked={!!effective.triggers?.firstFailure?.enabled}
              />
              First failure after
            </label>
            <input
              name="trigger.firstFailure.afterSuccessCount"
              type="number"
              min={1}
              max={50}
              defaultValue={effective.triggers?.firstFailure?.afterSuccessCount ?? 5}
              aria-label="Number of consecutive successes before re-arming first-failure alerts"
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>successes</span>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Cooldown minutes (override)
            </span>
            <input
              name="cooldownMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={effective.cooldownMinutes ?? 15}
              className="h-9 w-32 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </section>

        <button
          type="submit"
          className="h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Save destination alerts
        </button>
      </form>
    </div>
  );
}
