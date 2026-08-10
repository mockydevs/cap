import { z } from "zod";

export const updateRetentionPolicySchema = z
  .object({
    recordingRetentionDays: z.number().int().min(1).max(3650).nullable(),
    deletedRecordingPurgeDays: z.number().int().min(1).max(3650),
  })
  .strict();
