import { z } from "zod";

const uuid = z.string().uuid();
export const createUploadSchema = z.object({
  title: z.string().trim().min(1).max(255),
  contentType: z.enum(["video/webm", "video/mp4"]),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024 * 1024),
});
export const signPartSchema = z.object({ partNumber: z.number().int().min(1).max(10_000) });
export const completeUploadSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(512) })).min(1).max(10_000),
}).refine(({ parts }) => new Set(parts.map((part) => part.partNumber)).size === parts.length, "Part numbers must be unique");
export const sessionParamsSchema = z.object({ sessionId: uuid });
export const UPLOAD_PART_SIZE_BYTES = 10 * 1024 * 1024;
