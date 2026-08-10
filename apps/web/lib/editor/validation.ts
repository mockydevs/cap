import { editorDocumentV2Schema } from "@cap/editor-domain";
import { z } from "zod";

export const editorSaveSchema = z
  .object({
    projectId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    document: editorDocumentV2Schema,
  })
  .strict();

export const editorProjectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

export const renderParamsSchema = z.object({
  renderJobId: z.string().uuid(),
});

export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["INTRO", "OUTRO", "GENERAL"]),
  })
  .strict();

export const applyTemplateSchema = z
  .object({ position: z.enum(["INTRO", "OUTRO"]) })
  .strict();

export const templateParamsSchema = z.object({
  templateId: z.string().uuid(),
});
