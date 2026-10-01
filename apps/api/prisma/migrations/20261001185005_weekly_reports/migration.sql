-- CreateEnum
CREATE TYPE "ReportSource" AS ENUM ('WEEK_CLOSED', 'MANUAL');

-- CreateTable
CREATE TABLE "weekly_reports" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "weekId" UUID NOT NULL,
    "source" "ReportSource" NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "sheetCount" INTEGER NOT NULL,
    "generatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" UUID,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_reports_workspaceId_createdAt_idx" ON "weekly_reports"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "weekly_reports_weekId_idx" ON "weekly_reports"("weekId");

-- CreateIndex
CREATE INDEX "weekly_reports_expiresAt_purgedAt_idx" ON "weekly_reports"("expiresAt", "purgedAt");

-- CreateIndex
CREATE INDEX "weekly_reports_generatedById_idx" ON "weekly_reports"("generatedById");

-- CreateIndex
CREATE INDEX "weekly_reports_deletedById_idx" ON "weekly_reports"("deletedById");

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
