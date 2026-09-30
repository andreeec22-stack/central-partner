-- CreateEnum
CREATE TYPE "WeekStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KpiType" AS ENUM ('RESULT', 'COMPLIANCE', 'PROGRESS');

-- CreateEnum
CREATE TYPE "FunctionFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'WHEN_OCCURS', 'WHEN_CHANGES');

-- CreateEnum
CREATE TYPE "FunctionFulfillment" AS ENUM ('YES', 'PARTIAL', 'NO', 'NOT_APPLICABLE');

-- AlterEnum
ALTER TYPE "Semaphore" ADD VALUE 'GRAY';

-- AlterEnum
ALTER TYPE "TaskSourceType" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "semaphore",
ADD COLUMN     "carriedFromWeekId" UUID,
ADD COLUMN     "weekId" UUID;

-- AlterTable
ALTER TABLE "weekly_archives" ADD COLUMN     "weekId" UUID;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "timezone" VARCHAR(50) NOT NULL DEFAULT 'America/Lima';

-- CreateTable
CREATE TABLE "weeks" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "mondayDate" DATE NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "WeekStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "archivedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpis" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "weekId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "type" "KpiType" NOT NULL DEFAULT 'RESULT',
    "unit" VARCHAR(20),
    "target" DECIMAL(14,4) NOT NULL,
    "actual" DECIMAL(14,4),
    "lesserIsBetter" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3),
    "recordedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_functions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "weekId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500),
    "frequency" "FunctionFrequency" NOT NULL DEFAULT 'WEEKLY',
    "fulfilled" "FunctionFulfillment",
    "observation" VARCHAR(500),
    "order" INTEGER NOT NULL DEFAULT 0,
    "markedAt" TIMESTAMP(3),
    "markedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_observations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "weekId" UUID NOT NULL,
    "observation" VARCHAR(1000) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weeks_workspaceId_status_idx" ON "weeks"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "weeks_workspaceId_mondayDate_key" ON "weeks"("workspaceId", "mondayDate");

-- CreateIndex
CREATE INDEX "kpis_weekId_departmentId_idx" ON "kpis"("weekId", "departmentId");

-- CreateIndex
CREATE INDEX "department_functions_weekId_departmentId_idx" ON "department_functions"("weekId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "task_observations_taskId_weekId_key" ON "task_observations"("taskId", "weekId");

-- CreateIndex
CREATE INDEX "tasks_weekId_departmentId_idx" ON "tasks"("weekId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_archives_weekId_key" ON "weekly_archives"("weekId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_carriedFromWeekId_fkey" FOREIGN KEY ("carriedFromWeekId") REFERENCES "weeks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_archives" ADD CONSTRAINT "weekly_archives_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weeks" ADD CONSTRAINT "weeks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpis" ADD CONSTRAINT "kpis_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpis" ADD CONSTRAINT "kpis_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpis" ADD CONSTRAINT "kpis_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_functions" ADD CONSTRAINT "department_functions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_functions" ADD CONSTRAINT "department_functions_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_functions" ADD CONSTRAINT "department_functions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_observations" ADD CONSTRAINT "task_observations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_observations" ADD CONSTRAINT "task_observations_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_observations" ADD CONSTRAINT "task_observations_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_observations" ADD CONSTRAINT "task_observations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: every existing task joins the week (Monday, workspace timezone)
-- of its due date, or of its creation when it has none.
INSERT INTO "weeks" ("id", "workspaceId", "mondayDate", "weekNumber", "year", "updatedAt")
SELECT gen_random_uuid(), m."workspaceId", m.monday,
       EXTRACT(WEEK FROM m.monday)::int, EXTRACT(ISOYEAR FROM m.monday)::int, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT t."workspaceId",
         date_trunc('week', (COALESCE(t."dueDate", t."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE w."timezone")::date AS monday
  FROM "tasks" t JOIN "workspaces" w ON w."id" = t."workspaceId"
) m;

UPDATE "tasks" t
SET "weekId" = wk."id"
FROM "workspaces" w, "weeks" wk
WHERE w."id" = t."workspaceId"
  AND wk."workspaceId" = t."workspaceId"
  AND wk."mondayDate" = date_trunc('week', (COALESCE(t."dueDate", t."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE w."timezone")::date;
