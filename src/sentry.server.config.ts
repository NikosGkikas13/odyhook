import * as Sentry from "@sentry/nextjs";

import { scrubSentryEvent } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // No-op when DSN is missing (e.g., local dev without secrets), so the
  // SDK doesn't try to send events to nowhere.
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
});
