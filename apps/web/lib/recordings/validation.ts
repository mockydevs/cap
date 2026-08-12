import { z } from "zod";

export const recordingParamsSchema = z.object({
  recordingId: z.string().uuid(),
});
export const recordingListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  view: z.enum(["library", "shared", "starred", "trash"]).default("library"),
});
