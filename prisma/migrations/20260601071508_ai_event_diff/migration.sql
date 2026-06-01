-- CreateTable
CREATE TABLE "AiEventDiff" (
    "id" TEXT NOT NULL,
    "eventAId" TEXT NOT NULL,
    "eventBId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "modelUsed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEventDiff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiEventDiff_eventAId_eventBId_key" ON "AiEventDiff"("eventAId", "eventBId");

-- AddForeignKey
ALTER TABLE "AiEventDiff" ADD CONSTRAINT "AiEventDiff_eventAId_fkey" FOREIGN KEY ("eventAId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEventDiff" ADD CONSTRAINT "AiEventDiff_eventBId_fkey" FOREIGN KEY ("eventBId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
