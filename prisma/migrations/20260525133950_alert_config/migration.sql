-- AlterTable
ALTER TABLE "Destination" ADD COLUMN     "alertConfigJson" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "alertConfigJson" JSONB;
