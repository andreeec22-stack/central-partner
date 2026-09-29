-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'JEFE_AREA', 'USER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "Semaphore" AS ENUM ('GREEN', 'YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "TaskSourceType" AS ENUM ('MANUAL', 'EXCEL_IMPORT');

-- CreateEnum
CREATE TYPE "ExcelImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "ComplexityCategory" AS ENUM ('SIMPLE', 'STANDARD', 'COMPLEX', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DeadlineAdherence" AS ENUM ('EARLY', 'ON_TIME', 'LATE', 'NO_DEADLINE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TASK_ASSIGNED', 'MENTIONED', 'COMMENT_REPLY', 'TASK_BLOCKED', 'TASK_COMPLETED', 'KPI_REMINDER');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "deleteRequestedAt" TIMESTAMP(3),
    "deleteRequestedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_branding" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "logoUrl" TEXT,
    "colorPrimary" VARCHAR(7) NOT NULL DEFAULT '#2563EB',
    "colorSuccess" VARCHAR(7) NOT NULL DEFAULT '#10B981',
    "colorWarning" VARCHAR(7) NOT NULL DEFAULT '#F59E0B',
    "colorDanger" VARCHAR(7) NOT NULL DEFAULT '#EF4444',
    "workspaceName" VARCHAR(50) NOT NULL DEFAULT 'Central Partner',
    "tagline" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "color" VARCHAR(7),
    "description" VARCHAR(500),
    "headId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" VARCHAR(100) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "departmentId" UUID,
    "phoneNumber" VARCHAR(20),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'UTC',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "Role" NOT NULL,
    "departmentId" UUID,
    "phoneNumber" VARCHAR(20),
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" VARCHAR(255),
    "ipAddress" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_visibility" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "jefeAreaId" UUID NOT NULL,
    "visibleDepartmentIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_visibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_preferences" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "enableWhatsApp" BOOLEAN NOT NULL DEFAULT false,
    "whatsAppEvents" JSONB NOT NULL DEFAULT '{}',
    "quietHoursStart" VARCHAR(5),
    "quietHoursEnd" VARCHAR(5),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "assignedToId" UUID,
    "createdById" UUID NOT NULL,
    "parentTaskId" UUID,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "semaphore" "Semaphore" NOT NULL DEFAULT 'RED',
    "dueDate" TIMESTAMP(3),
    "blockReason" VARCHAR(255),
    "blockedSince" TIMESTAMP(3),
    "blockedByUserId" UUID,
    "kpiTarget" VARCHAR(255),
    "kpiActual" VARCHAR(255),
    "kpiRecordedAt" TIMESTAMP(3),
    "sourceType" "TaskSourceType" NOT NULL DEFAULT 'MANUAL',
    "excelImportId" UUID,
    "actualStartDate" TIMESTAMP(3),
    "actualCompletionDate" TIMESTAMP(3),
    "actualDurationHours" DOUBLE PRECISION,
    "timeToCompletionHours" DOUBLE PRECISION,
    "completionDelayDays" DOUBLE PRECISION,
    "wasBlocked" BOOLEAN NOT NULL DEFAULT false,
    "totalCommentsCount" INTEGER NOT NULL DEFAULT 0,
    "totalMentionsCount" INTEGER NOT NULL DEFAULT 0,
    "collaborationParticipantIds" UUID[],
    "priorityAtCompletion" "Priority",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "dependsOnTaskId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "mentionedUserIds" UUID[],
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_files" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(127) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "task_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" VARCHAR(1000),
    "taskId" UUID,
    "actorId" UUID,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" UUID,
    "changes" JSONB,
    "metadata" JSONB,
    "ipAddress" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_archives" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excel_imports" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "fileKey" VARCHAR(512) NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawData" JSONB NOT NULL,
    "detectedTasks" JSONB NOT NULL,
    "mappedTasksCount" INTEGER NOT NULL DEFAULT 0,
    "unmappedRowsCount" INTEGER NOT NULL DEFAULT 0,
    "mappingLog" JSONB,
    "status" "ExcelImportStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "excel_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_performance_snapshots" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "departmentId" UUID,
    "snapshotDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period" "SnapshotPeriod" NOT NULL,
    "tasksCompletedInPeriod" INTEGER NOT NULL DEFAULT 0,
    "tasksAssignedInPeriod" INTEGER NOT NULL DEFAULT 0,
    "onTimeCompletionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lateCompletionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgTaskDurationHours" DOUBLE PRECISION,
    "medianTaskDurationHours" DOUBLE PRECISION,
    "collaborationScore" INTEGER NOT NULL DEFAULT 0,
    "kpisRecorded" INTEGER NOT NULL DEFAULT 0,
    "overdueTasks" INTEGER NOT NULL DEFAULT 0,
    "blockedTasks" INTEGER NOT NULL DEFAULT 0,
    "commentsWritten" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_performance_metrics" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "departmentId" UUID,
    "completionEfficiencyScore" DOUBLE PRECISION NOT NULL,
    "priorityImpact" "Priority" NOT NULL,
    "complexityCategory" "ComplexityCategory" NOT NULL,
    "deadlineAdherence" "DeadlineAdherence" NOT NULL,
    "assignedUserId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "task_performance_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secretKey" VARCHAR(255) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_branding_workspaceId_key" ON "workspace_branding"("workspaceId");

-- CreateIndex
CREATE INDEX "departments_workspaceId_deletedAt_idx" ON "departments"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspaceId_slug_key" ON "departments"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_workspaceId_departmentId_idx" ON "users"("workspaceId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "users_workspaceId_email_key" ON "users"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_workspaceId_email_idx" ON "invitations"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "department_visibility_jefeAreaId_key" ON "department_visibility"("jefeAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "department_visibility_workspaceId_jefeAreaId_key" ON "department_visibility"("workspaceId", "jefeAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preferences_userId_key" ON "user_notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preferences_workspaceId_userId_key" ON "user_notification_preferences"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_deletedAt_departmentId_status_idx" ON "tasks"("workspaceId", "deletedAt", "departmentId", "status");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_assignedToId_idx" ON "tasks"("workspaceId", "assignedToId");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_dueDate_idx" ON "tasks"("workspaceId", "dueDate");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_createdAt_idx" ON "tasks"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "tasks_parentTaskId_idx" ON "tasks"("parentTaskId");

-- CreateIndex
CREATE INDEX "task_dependencies_workspaceId_idx" ON "task_dependencies"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_taskId_dependsOnTaskId_key" ON "task_dependencies"("taskId", "dependsOnTaskId");

-- CreateIndex
CREATE INDEX "comments_taskId_createdAt_idx" ON "comments"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "task_files_taskId_idx" ON "task_files"("taskId");

-- CreateIndex
CREATE INDEX "task_files_deletedAt_idx" ON "task_files"("deletedAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_workspaceId_createdAt_idx" ON "activity_logs"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_workspaceId_entityType_entityId_idx" ON "activity_logs"("workspaceId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "activity_logs_workspaceId_userId_idx" ON "activity_logs"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_archives_workspaceId_weekStart_key" ON "weekly_archives"("workspaceId", "weekStart");

-- CreateIndex
CREATE INDEX "excel_imports_workspaceId_createdAt_idx" ON "excel_imports"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "user_performance_snapshots_workspaceId_period_snapshotDate_idx" ON "user_performance_snapshots"("workspaceId", "period", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "user_performance_snapshots_workspaceId_userId_snapshotDate__key" ON "user_performance_snapshots"("workspaceId", "userId", "snapshotDate", "period");

-- CreateIndex
CREATE UNIQUE INDEX "task_performance_metrics_taskId_key" ON "task_performance_metrics"("taskId");

-- CreateIndex
CREATE INDEX "task_performance_metrics_workspaceId_completedAt_idx" ON "task_performance_metrics"("workspaceId", "completedAt");

-- AddForeignKey
ALTER TABLE "workspace_branding" ADD CONSTRAINT "workspace_branding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_headId_fkey" FOREIGN KEY ("headId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_visibility" ADD CONSTRAINT "department_visibility_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_visibility" ADD CONSTRAINT "department_visibility_jefeAreaId_fkey" FOREIGN KEY ("jefeAreaId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_blockedByUserId_fkey" FOREIGN KEY ("blockedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_excelImportId_fkey" FOREIGN KEY ("excelImportId") REFERENCES "excel_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_archives" ADD CONSTRAINT "weekly_archives_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excel_imports" ADD CONSTRAINT "excel_imports_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excel_imports" ADD CONSTRAINT "excel_imports_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_performance_snapshots" ADD CONSTRAINT "user_performance_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_performance_snapshots" ADD CONSTRAINT "user_performance_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_performance_snapshots" ADD CONSTRAINT "user_performance_snapshots_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_performance_metrics" ADD CONSTRAINT "task_performance_metrics_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_performance_metrics" ADD CONSTRAINT "task_performance_metrics_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_performance_metrics" ADD CONSTRAINT "task_performance_metrics_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_performance_metrics" ADD CONSTRAINT "task_performance_metrics_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_performance_metrics" ADD CONSTRAINT "task_performance_metrics_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Integrity rules Prisma can't express (safety net under API validation) ───
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_progress_range" CHECK ("progress" BETWEEN 0 AND 100);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_blocked_requires_reason"
  CHECK ("status" <> 'BLOCKED' OR ("blockReason" IS NOT NULL AND length(btrim("blockReason")) > 0));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_not_own_parent" CHECK ("parentTaskId" IS NULL OR "parentTaskId" <> "id");
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_not_self" CHECK ("taskId" <> "dependsOnTaskId");
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_size_limit" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 52428800);
ALTER TABLE "workspace_branding" ADD CONSTRAINT "workspace_branding_hex_colors" CHECK (
  "colorPrimary" ~ '^#[0-9A-Fa-f]{6}$' AND "colorSuccess" ~ '^#[0-9A-Fa-f]{6}$' AND
  "colorWarning" ~ '^#[0-9A-Fa-f]{6}$' AND "colorDanger" ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "notification_prefs_quiet_hours_format" CHECK (
  ("quietHoursStart" IS NULL OR "quietHoursStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
  ("quietHoursEnd" IS NULL OR "quietHoursEnd" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
