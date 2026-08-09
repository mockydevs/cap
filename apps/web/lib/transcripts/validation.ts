import { z } from "zod";

export const transcriptLanguageSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, "Use a BCP 47 language tag");

export const transcriptSegmentUpdateSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  speakerLabel: z.string().trim().min(1).max(120).nullable().optional(),
  expectedCorrectionRevision: z.number().int().min(0),
});

export const transcriptListSchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export const transcriptSearchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const transcriptLanguageUpdateSchema = z.object({
  language: transcriptLanguageSchema.nullable(),
});
