import { z } from "zod";

export const viewGrantParamsSchema = z.object({
  grant: z
    .string()
    .min(80)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/),
});
export const viewEventSchema = z.object({
  eventId: z.string().uuid(),
  kind: z.enum(["HEARTBEAT", "ENDED"]),
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60 * 1000),
  deltaMs: z.number().int().min(0).max(30_000),
});
