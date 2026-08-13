import { z } from "zod";

export const recordingParamsSchema = z.object({
  recordingId: z.string().uuid(),
});
export const shareTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const updateSharingSchema = z
  .object({
    visibility: z.enum(["PRIVATE", "LINK", "PUBLIC"]),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.visibility !== "LINK" && value.expiresInHours !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Expiry is only valid for share links",
        path: ["expiresInHours"],
      });
    }
  });
