import { z } from "zod";
import { WEBHOOK_EVENTS } from "./service";

export const createWebhookEndpointSchema = z
  .object({
    url: z.string().url().startsWith("https://").max(2048),
    description: z.string().trim().max(300).optional(),
    enabledEvents: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  })
  .strict();

export const webhookParamsSchema = z.object({ webhookId: z.string().uuid() });
