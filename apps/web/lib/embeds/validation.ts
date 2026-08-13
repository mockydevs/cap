import { z } from "zod";

const origin = z
  .string()
  .url()
  .transform((value, context) => {
    const parsed = new URL(value);
    const allowed =
      parsed.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" &&
        parsed.protocol === "http:" &&
        parsed.hostname === "localhost");
    if (!allowed || parsed.username || parsed.password) {
      context.addIssue({
        code: "custom",
        message: "Only secure origins are allowed",
      });
      return z.NEVER;
    }
    return parsed.origin;
  });

export const embedPolicySchema = z
  .object({
    enabled: z.boolean(),
    allowedOrigins: z.array(origin).max(20),
  })
  .superRefine((value, context) => {
    if (value.enabled && value.allowedOrigins.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Enabled embeds require an origin",
      });
    }
    if (new Set(value.allowedOrigins).size !== value.allowedOrigins.length) {
      context.addIssue({
        code: "custom",
        message: "Embed origins must be unique",
      });
    }
  });

export const embedPlaybackSchema = z.object({
  shareToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
