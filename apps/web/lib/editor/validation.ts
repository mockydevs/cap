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
