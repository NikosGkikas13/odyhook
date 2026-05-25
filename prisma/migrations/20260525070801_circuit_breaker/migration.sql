-- AlterTable
ALTER TABLE "Destination" ADD COLUMN     "autoDisabledAt" TIMESTAMP(3),
ADD COLUMN     "autoDisabledReason" TEXT,
ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
