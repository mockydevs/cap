import { z } from "zod";

export const createApiKeySchema = z
  .object({ name: z.string().trim().min(2).max(120) })
  .strict();

export const apiKeyParamsSchema = z.object({ apiKeyId: z.string().uuid() });
