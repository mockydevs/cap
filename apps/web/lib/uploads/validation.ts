import { z } from "zod";

const uuid = z.string().uuid();
const checksumSha256 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const etag = z
  .string()
  .min(3)
  .max(130)
  .regex(/^"[^"\r\n]+"$/);

const createUploadBaseSchema = z.object({
  title: z.string().trim().min(1).max(255),
  contentType: z.enum(["video/webm", "video/mp4"]),
  /** Marks this as a camera recording captured alongside an existing (usually screen) recording. */
  linkedRecordingId: uuid.optional(),
});

export const MAX_BROWSER_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const createUploadSchema = z.discriminatedUnion("streaming", [
  createUploadBaseSchema.extend({
    streaming: z.literal(true),
    sizeBytes: z.never().optional(),
  }),
  createUploadBaseSchema.extend({
    streaming: z.literal(false).optional(),
    sizeBytes: z.number().int().positive().max(MAX_BROWSER_UPLOAD_BYTES),
  }),
]);

export const signPartSchema = z.object({
  contentLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024 * 1024),
  checksumSha256,
  isFinalPart: z.boolean(),
});

export const completeUploadSchema = z
  .object({
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(10_000),
          etag,
          checksumSha256,
        }),
      )
      .min(1)
      .max(10_000),
  })
  .refine(
    ({ parts }) =>
      new Set(parts.map((part) => part.partNumber)).size === parts.length,
    "Part numbers must be unique",
  );

export const sessionParamsSchema = z.object({ sessionId: uuid });
export const partParamsSchema = z.object({
  sessionId: uuid,
  partNumber: z.coerce.number().int().min(1).max(10_000),
});
export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[\x21-\x7E]+$/);
export const UPLOAD_PART_SIZE_BYTES = 10 * 1024 * 1024;
