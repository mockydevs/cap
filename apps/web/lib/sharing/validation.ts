import { z } from "zod";

export const recordingParamsSchema = z.object({
  recordingId: z.string().uuid(),
});
export const shareTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const updateSharingSchema = z
  .object({
    visibility: z.enum(["PRIVATE", "LINK", "PASSWORD", "PUBLIC"]),
    password: z.string().min(10).max(256).optional(),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.visibility === "PASSWORD" && !value.password) {
      context.addIssue({
        code: "custom",
        message: "Password is required",
        path: ["password"],
      });
    }
    if (value.visibility !== "PASSWORD" && value.password !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Password is only valid for PASSWORD mode",
        path: ["password"],
      });
    }
    if (
      (value.visibility === "PRIVATE" || value.visibility === "PUBLIC") &&
      value.expiresInHours !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Expiry is only valid for share links",
        path: ["expiresInHours"],
      });
    }
  });

export const sharePlaybackSchema = z.object({
  password: z.string().min(1).max(256).optional(),
});
