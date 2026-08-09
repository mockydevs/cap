import { aiCapabilitySchema } from "@cap/ai";
import { z } from "zod";
export const createAiJobSchema = z
  .object({
    capability: aiCapabilitySchema.exclude(["SEARCH_INDEX"]),
    question: z.string().trim().min(2).max(2000).optional(),
    targetLanguage: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.capability === "QUESTIONS_ANSWERS" && !value.question)
      ctx.addIssue({
        code: "custom",
        message: "A question is required",
        path: ["question"],
      });
    if (value.capability === "TRANSLATION" && !value.targetLanguage)
      ctx.addIssue({
        code: "custom",
        message: "A target language is required",
        path: ["targetLanguage"],
      });
  });
export const artifactDecisionSchema = z
  .object({ status: z.enum(["ACCEPTED", "REJECTED"]) })
  .strict();
export const aiPolicySchema = z
  .object({
    enabled: z.boolean(),
    allowExternalProcessing: z.boolean(),
    allowedProvider: z.enum(["openai-compatible", "self-hosted"]),
    monthlyTokenLimit: z.number().int().min(0).max(100_000_000),
    monthlyCostLimitMicrounits: z.number().int().min(0).max(10_000_000_000),
  })
  .strict();
export const semanticSearchSchema = z
  .object({
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
