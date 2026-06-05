import * as Sentry from "@sentry/nextjs";

import { scrubSentryEvent } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
});
