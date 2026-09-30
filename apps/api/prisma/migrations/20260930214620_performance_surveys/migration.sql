-- CreateEnum
CREATE TYPE "SurveyTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('LIKERT_5', 'LIKERT_7', 'NUMERIC', 'TEXT', 'RANKING');

-- CreateEnum
CREATE TYPE "SurveyType" AS ENUM ('SELF_ASSESSMENT', 'MANAGER_REVIEW');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PerformanceRating" AS ENUM ('EXCEEDS_EXPECTATIONS', 'MEETS_EXPECTATIONS', 'DEVELOPING', 'NEEDS_IMPROVEMENT', 'NOT_YET_RATED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SURVEY_ASSIGNED';

-- CreateTable
CREATE TABLE "survey_templates" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "status" "SurveyTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "survey_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_questions" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "questionNumber" INTEGER NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "questionType" "SurveyQuestionType" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "options" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "type" "SurveyType" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000),
    "evaluatorId" UUID NOT NULL,
    "evaluatedUserId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'SCHEDULED',
    "reviewPeriod" VARCHAR(7) NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "answeredQuestions" INTEGER NOT NULL DEFAULT 0,
    "completionPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "productivityIndex" DOUBLE PRECISION,
    "productivityData" JSONB,
    "performanceScore" DOUBLE PRECISION,
    "dualScore" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_responses" (
    "id" UUID NOT NULL,
    "surveyId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "respondentId" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "comment" VARCHAR(2000),
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_reviews" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "departmentId" UUID,
    "reviewPeriod" VARCHAR(7) NOT NULL,
    "performanceData" JSONB,
    "surveysCompleted" INTEGER NOT NULL DEFAULT 0,
    "surveysInitiated" INTEGER NOT NULL DEFAULT 0,
    "selfAssessmentScore" DOUBLE PRECISION,
    "managerReviewScore" DOUBLE PRECISION,
    "overallPerformanceScore" DOUBLE PRECISION,
    "overallProductivityIndex" DOUBLE PRECISION,
    "overallDualScore" DOUBLE PRECISION,
    "performanceRating" "PerformanceRating" NOT NULL DEFAULT 'NOT_YET_RATED',
    "riskLevel" "RiskLevel",
    "managerComments" VARCHAR(4000),
    "employeeComments" VARCHAR(4000),
    "strengths" TEXT[],
    "areasForImprovement" TEXT[],
    "developmentGoals" TEXT[],
    "nextReviewDate" DATE,
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "survey_templates_workspaceId_status_idx" ON "survey_templates"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "survey_templates_createdById_idx" ON "survey_templates"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "survey_questions_templateId_questionNumber_key" ON "survey_questions"("templateId", "questionNumber");

-- CreateIndex
CREATE INDEX "surveys_workspaceId_status_createdAt_idx" ON "surveys"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "surveys_templateId_idx" ON "surveys"("templateId");

-- CreateIndex
CREATE INDEX "surveys_evaluatorId_status_idx" ON "surveys"("evaluatorId", "status");

-- CreateIndex
CREATE INDEX "surveys_evaluatedUserId_createdAt_idx" ON "surveys"("evaluatedUserId", "createdAt");

-- CreateIndex
CREATE INDEX "surveys_evaluatedUserId_reviewPeriod_status_idx" ON "surveys"("evaluatedUserId", "reviewPeriod", "status");

-- CreateIndex
CREATE INDEX "surveys_departmentId_status_idx" ON "surveys"("departmentId", "status");

-- CreateIndex
CREATE INDEX "surveys_status_startDate_idx" ON "surveys"("status", "startDate");

-- CreateIndex
CREATE INDEX "surveys_status_endDate_idx" ON "surveys"("status", "endDate");

-- CreateIndex
CREATE INDEX "surveys_createdById_idx" ON "surveys"("createdById");

-- CreateIndex
CREATE INDEX "survey_responses_questionId_idx" ON "survey_responses"("questionId");

-- CreateIndex
CREATE INDEX "survey_responses_respondentId_idx" ON "survey_responses"("respondentId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_responses_surveyId_questionId_key" ON "survey_responses"("surveyId", "questionId");

-- CreateIndex
CREATE INDEX "performance_reviews_workspaceId_reviewPeriod_departmentId_idx" ON "performance_reviews"("workspaceId", "reviewPeriod", "departmentId");

-- CreateIndex
CREATE INDEX "performance_reviews_workspaceId_performanceRating_idx" ON "performance_reviews"("workspaceId", "performanceRating");

-- CreateIndex
CREATE INDEX "performance_reviews_departmentId_idx" ON "performance_reviews"("departmentId");

-- CreateIndex
CREATE INDEX "performance_reviews_publishedById_idx" ON "performance_reviews"("publishedById");

-- CreateIndex
CREATE UNIQUE INDEX "performance_reviews_userId_reviewPeriod_key" ON "performance_reviews"("userId", "reviewPeriod");

-- AddForeignKey
ALTER TABLE "survey_templates" ADD CONSTRAINT "survey_templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_templates" ADD CONSTRAINT "survey_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "survey_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "survey_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_evaluatedUserId_fkey" FOREIGN KEY ("evaluatedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "survey_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_respondentId_fkey" FOREIGN KEY ("respondentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
