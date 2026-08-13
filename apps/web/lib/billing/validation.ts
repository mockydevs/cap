import { z } from "zod";

export const startCheckoutSchema = z
  .object({
    planCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .strict();
