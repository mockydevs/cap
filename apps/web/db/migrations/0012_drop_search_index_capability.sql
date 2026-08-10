ALTER TYPE "ai_capability" RENAME TO "ai_capability_old";
CREATE TYPE "ai_capability" AS ENUM ('TITLE_DESCRIPTION','SUMMARY','CHAPTERS','ACTION_ITEMS','HIGHLIGHTS','QUESTIONS_ANSWERS','TRANSLATION','FOLLOW_UP','SENSITIVE_DATA');
ALTER TABLE "ai_jobs" ALTER COLUMN "capability" TYPE "ai_capability" USING "capability"::text::"ai_capability";
ALTER TABLE "ai_artifacts" ALTER COLUMN "capability" TYPE "ai_capability" USING "capability"::text::"ai_capability";
DROP TYPE "ai_capability_old";
