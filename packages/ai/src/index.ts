import { createHash } from "node:crypto";
import { z } from "zod";

export const aiCapabilitySchema = z.enum([
  "TITLE_DESCRIPTION",
  "SUMMARY",
  "CHAPTERS",
  "ACTION_ITEMS",
  "HIGHLIGHTS",
  "QUESTIONS_ANSWERS",
  "TRANSLATION",
  "FOLLOW_UP",
  "SENSITIVE_DATA",
]);
export type AiCapability = z.infer<typeof aiCapabilitySchema>;
export const aiProviderSchema = z.enum([
  "OPENAI",
  "ANTHROPIC",
  "OPENAI_COMPATIBLE",
]);
export type AiProviderKind = z.infer<typeof aiProviderSchema>;
export const providerCapabilitySchema = z.enum([
  "ANALYSIS",
  "EMBEDDINGS",
  "TRANSCRIPTION",
]);
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export const aiJobSchema = z
  .object({
    jobId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    recordingId: z.string().uuid(),
    transcriptId: z.string().uuid(),
    transcriptRevision: z.number().int().nonnegative(),
    capability: aiCapabilitySchema,
    requestedBy: z.string().uuid(),
    question: z.string().trim().min(2).max(2000).optional(),
    targetLanguage: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
      .optional(),
  })
  .strict();
export type AiJob = z.infer<typeof aiJobSchema>;

export const aiArtifactContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("TITLE_DESCRIPTION"),
    title: z.string().min(1).max(160),
    description: z.string().max(5000),
  }),
  z.object({
    kind: z.literal("SUMMARY"),
    concise: z.string().min(1).max(5000),
    detailed: z.string().min(1).max(20000),
  }),
  z.object({
    kind: z.literal("CHAPTERS"),
    chapters: z
      .array(
        z.object({
          startMs: z.number().int().nonnegative(),
          title: z.string().min(1).max(160),
        }),
      )
      .min(1)
      .max(100),
  }),
  z.object({
    kind: z.literal("ACTION_ITEMS"),
    actionItems: z
      .array(
        z.object({
          text: z.string().min(1).max(1000),
          owner: z.string().max(160).nullable(),
          dueDate: z.string().date().nullable(),
        }),
      )
      .max(100),
    decisions: z.array(z.string().min(1).max(2000)).max(100),
  }),
  z.object({
    kind: z.literal("HIGHLIGHTS"),
    highlights: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            reason: z.string().min(1).max(1000),
          })
          .refine((value) => value.endMs > value.startMs),
      )
      .max(100),
  }),
  z.object({
    kind: z.literal("QUESTIONS_ANSWERS"),
    question: z.string().min(2).max(2000),
    answer: z.string().min(1).max(10000),
    citations: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
          })
          .refine((value) => value.endMs > value.startMs),
      )
      .max(20),
    insufficientEvidence: z.boolean(),
  }),
  z.object({
    kind: z.literal("TRANSLATION"),
    language: z.string(),
    text: z.string().min(1).max(50000),
    /** Per-segment translation for caption tracks; startMs/endMs echo the source transcript's. */
    segments: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            text: z.string().min(1).max(2_000),
          })
          .refine((value) => value.endMs > value.startMs),
      )
      .max(50_000)
      .optional(),
  }),
  z.object({
    kind: z.literal("FOLLOW_UP"),
    subject: z.string().max(300),
    body: z.string().min(1).max(20000),
  }),
  z.object({
    kind: z.literal("SENSITIVE_DATA"),
    findings: z
      .array(
        z.object({
          category: z.string().max(100),
          startMs: z.number().int().nonnegative(),
          excerpt: z.string().max(300),
        }),
      )
      .max(200),
  }),
]);
export type AiArtifactContent = z.infer<typeof aiArtifactContentSchema>;
export const transcriptInputHash = (text: string, revision: number) =>
  createHash("sha256").update(`${revision}\0${text}`).digest("hex");
export const PROMPT_TEMPLATE_VERSION = "2026-08-09.v1";
export function guardedTranscript(text: string) {
  if (!text.trim() || text.length > 500_000)
    throw new Error("Approved transcript is empty or too large");
  return `<untrusted_transcript>\n${text.replaceAll("</untrusted_transcript>", "&lt;/untrusted_transcript&gt;")}\n</untrusted_transcript>`;
}
