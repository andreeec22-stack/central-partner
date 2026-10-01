-- CreateEnum
CREATE TYPE "OkrLevel" AS ENUM ('COMPANY', 'AREA', 'PERSON');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'RESULT_RECALCULATED';

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "performanceTarget" INTEGER;

-- AlterTable
ALTER TABLE "performance_reviews" ADD COLUMN     "lastRecalculatedAt" TIMESTAMP(3),
ADD COLUMN     "recalculationCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "okrs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "level" "OkrLevel" NOT NULL,
    "parentId" UUID,
    "departmentId" UUID,
    "ownerUserId" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "deadline" DATE,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "okrs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_results" (
    "id" UUID NOT NULL,
    "okrId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20),
    "startValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target" DOUBLE PRECISION NOT NULL,
    "current" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "okr_check_ins" (
    "id" UUID NOT NULL,
    "okrId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL,
    "values" JSONB NOT NULL,
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "okr_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "okrs_workspaceId_period_level_idx" ON "okrs"("workspaceId", "period", "level");

-- CreateIndex
CREATE INDEX "okrs_parentId_idx" ON "okrs"("parentId");

-- CreateIndex
CREATE INDEX "okrs_departmentId_period_idx" ON "okrs"("departmentId", "period");

-- CreateIndex
CREATE INDEX "okrs_ownerUserId_period_idx" ON "okrs"("ownerUserId", "period");

-- CreateIndex
CREATE INDEX "okrs_createdById_idx" ON "okrs"("createdById");

-- CreateIndex
CREATE INDEX "key_results_okrId_order_idx" ON "key_results"("okrId", "order");

-- CreateIndex
CREATE INDEX "okr_check_ins_okrId_createdAt_idx" ON "okr_check_ins"("okrId", "createdAt");

-- CreateIndex
CREATE INDEX "okr_check_ins_authorId_idx" ON "okr_check_ins"("authorId");

-- AddForeignKey
ALTER TABLE "okrs" ADD CONSTRAINT "okrs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "okrs" ADD CONSTRAINT "okrs_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "okrs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "okrs" ADD CONSTRAINT "okrs_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "okrs" ADD CONSTRAINT "okrs_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "okrs" ADD CONSTRAINT "okrs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_okrId_fkey" FOREIGN KEY ("okrId") REFERENCES "okrs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "okr_check_ins" ADD CONSTRAINT "okr_check_ins_okrId_fkey" FOREIGN KEY ("okrId") REFERENCES "okrs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "okr_check_ins" ADD CONSTRAINT "okr_check_ins_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
