import { z } from "zod";

export const commentParamsSchema = z.object({
  recordingId: z.string().uuid(),
  commentId: z.string().uuid().optional(),
});
export const listCommentsSchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(2_000),
  timestampMs: z.number().int().min(0).max(86_400_000),
  guestName: z.string().trim().min(2).max(80).optional(),
  viewerKey: z.string().uuid().optional(),
  password: z.string().max(256).optional(),
});
export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(2_000),
});
export const reactionSchema = z.object({
  emoji: z.enum(["👍", "❤️", "🎉", "😂", "👀"]),
  active: z.boolean(),
});
