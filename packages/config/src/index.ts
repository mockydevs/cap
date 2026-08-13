import { z } from "zod";

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().url().optional(),
);

export const serverEnvironmentSchema = z.object({
  AWS_REGION: z.string().trim().min(1).default("us-east-1"),
  AWS_S3_BUCKET_NAME: z.string().trim().min(3),
  AWS_KMS_KEY_ARN: optionalString,
  AWS_S3_ENDPOINT: optionalUrl,
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

/** Validates only server-side configuration. Never import credentials into client code. */
export function parseServerEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerEnvironment {
  return serverEnvironmentSchema.parse(environment);
}
