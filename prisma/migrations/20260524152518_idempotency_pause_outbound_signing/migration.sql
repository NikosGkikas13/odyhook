-- Destination: pause/disable + optional outbound HMAC signing secret.
ALTER TABLE "Destination"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "outboundSecretEnc" TEXT;

-- Event: per-source idempotency key for dedupe of provider retries.
-- Nullable on purpose so existing rows don't need a backfill — Postgres
-- treats multiple NULLs as distinct in a unique index, so legacy rows
-- coexist with new rows.
ALTER TABLE "Event"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Event_sourceId_idempotencyKey_key"
  ON "Event"("sourceId", "idempotencyKey");
