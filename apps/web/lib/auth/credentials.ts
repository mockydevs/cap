import { hash, verify, type Options } from "@node-rs/argon2";
import { z } from "zod";

export const signupSchema = z.object({
  displayName: z.string().trim().min(2).max(100),
  workspaceName: z.string().trim().min(2).max(100),
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
});
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
});

const passwordOptions = {
  // @node-rs/argon2 exposes Algorithm as an ambient const enum, which cannot be
  // referenced under Next.js isolated-module compilation. `2` is Argon2id.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;
export const hashPassword = (password: string) =>
  hash(password, passwordOptions);
export const verifyPassword = (encoded: string, password: string) =>
  verify(encoded, password);
