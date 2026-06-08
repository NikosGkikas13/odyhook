-- 1. New column on User
ALTER TABLE "User" ADD COLUMN "activeAiProvider" TEXT;

-- 2. New ProviderKey table
CREATE TABLE "ProviderKey" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyEnc" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderKey_pkey" PRIMARY KEY ("userId", "provider")
);
ALTER TABLE "ProviderKey" ADD CONSTRAINT "ProviderKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Migrate existing Anthropic keys into the new shape (BEFORE dropping the old table)
INSERT INTO "ProviderKey" ("userId", "provider", "keyEnc", "model", "createdAt", "updatedAt")
SELECT "userId", 'anthropic', "anthropicKeyEnc", NULL, "createdAt", "updatedAt"
FROM "UserApiKey";

UPDATE "User"
SET "activeAiProvider" = 'anthropic'
WHERE "id" IN (SELECT "userId" FROM "UserApiKey");

-- 4. Drop the old table (FK was on UserApiKey itself, no separate drop needed before this)
ALTER TABLE "UserApiKey" DROP CONSTRAINT "UserApiKey_userId_fkey";
DROP TABLE "UserApiKey";
