import { aiCapabilitySchema } from "@cap/ai";
import { z } from "zod";
export const createAiJobSchema = z
  .object({
    capability: aiCapabilitySchema,
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

const providerCapability = z.enum(["ANALYSIS", "EMBEDDINGS", "TRANSCRIPTION"]);
export const providerConnectionSchema = z
  .object({
    provider: z.enum(["OPENAI", "ANTHROPIC", "OPENAI_COMPATIBLE"]),
    displayName: z.string().trim().min(2).max(80),
    apiKey: z.string().trim().min(8).max(500),
    baseUrl: z.string().url().startsWith("https://").max(500).optional(),
    allowedCapabilities: z.array(providerCapability).min(1).max(3),
    allowedModels: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
    defaultModel: z.string().trim().min(1).max(120),
    dataRegion: z.string().trim().min(2).max(80).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.allowedModels.includes(value.defaultModel))
      ctx.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: "Default model must be in the model allowlist",
      });
    if (value.provider === "OPENAI_COMPATIBLE" && !value.baseUrl)
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "A custom provider requires an HTTPS base URL",
      });
  });
export const providerRouteSchema = z
  .object({
    purpose: providerCapability,
    connectionId: z.string().uuid(),
    model: z.string().trim().min(1).max(120),
  })
  .strict();
