-- CreateTable
CREATE TABLE "week_kpi_snapshots" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "weekId" UUID NOT NULL,
    "departmentKey" VARCHAR(36) NOT NULL,
    "departmentName" VARCHAR(80),
    "indexValue" DOUBLE PRECISION,
    "taskProgress" DOUBLE PRECISION,
    "kpiCompliance" DOUBLE PRECISION,
    "functionCompliance" DOUBLE PRECISION,
    "semaphore" "Semaphore",
    "tasksTotal" INTEGER NOT NULL,
    "tasksDue" INTEGER NOT NULL,
    "tasksDone" INTEGER NOT NULL,
    "tasksOverdue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "week_kpi_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "week_kpi_snapshots_workspaceId_weekId_idx" ON "week_kpi_snapshots"("workspaceId", "weekId");

-- CreateIndex
CREATE UNIQUE INDEX "week_kpi_snapshots_weekId_departmentKey_key" ON "week_kpi_snapshots"("weekId", "departmentKey");

-- AddForeignKey
ALTER TABLE "week_kpi_snapshots" ADD CONSTRAINT "week_kpi_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "week_kpi_snapshots" ADD CONSTRAINT "week_kpi_snapshots_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the frozen archives of the weeks already closed: the company
-- row ("ALL") and one row per area, with the numbers each archive closed at.
INSERT INTO "week_kpi_snapshots" ("id", "workspaceId", "weekId", "departmentKey", "departmentName", "indexValue", "taskProgress", "kpiCompliance", "functionCompliance", "semaphore", "tasksTotal", "tasksDue", "tasksDone", "tasksOverdue", "createdAt")
SELECT gen_random_uuid(), a."workspaceId", a."weekId", 'ALL', NULL,
       (a."data"->'overall'->>'index')::float8,
       (a."data"->'overall'->>'taskProgress')::float8,
       (a."data"->'overall'->>'kpiCompliance')::float8,
       (a."data"->'overall'->>'functionCompliance')::float8,
       (a."data"->'overall'->>'semaphore')::"Semaphore",
       COALESCE((a."data"->'overall'->'tasks'->>'total')::int, 0),
       COALESCE((a."data"->'overall'->'tasks'->>'due')::int, 0),
       COALESCE((a."data"->'overall'->'tasks'->>'done')::int, 0),
       COALESCE((a."data"->'overall'->'tasks'->>'overdue')::int, 0),
       a."createdAt"
FROM "weekly_archives" a
WHERE a."weekId" IS NOT NULL;

INSERT INTO "week_kpi_snapshots" ("id", "workspaceId", "weekId", "departmentKey", "departmentName", "indexValue", "taskProgress", "kpiCompliance", "functionCompliance", "semaphore", "tasksTotal", "tasksDue", "tasksDone", "tasksOverdue", "createdAt")
SELECT gen_random_uuid(), a."workspaceId", a."weekId", d->>'id', LEFT(d->>'name', 80),
       (d->'metrics'->>'index')::float8,
       (d->'metrics'->>'taskProgress')::float8,
       (d->'metrics'->>'kpiCompliance')::float8,
       (d->'metrics'->>'functionCompliance')::float8,
       (d->'metrics'->>'semaphore')::"Semaphore",
       COALESCE((d->'metrics'->'tasks'->>'total')::int, 0),
       COALESCE((d->'metrics'->'tasks'->>'due')::int, 0),
       COALESCE((d->'metrics'->'tasks'->>'done')::int, 0),
       COALESCE((d->'metrics'->'tasks'->>'overdue')::int, 0),
       a."createdAt"
FROM "weekly_archives" a
CROSS JOIN LATERAL jsonb_array_elements(a."data"->'departments') AS d
WHERE a."weekId" IS NOT NULL;
