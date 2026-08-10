import { z } from "zod";

const workspaceRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

export const inviteMemberSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
    role: workspaceRoleSchema.exclude(["OWNER"]),
  })
  .strict();

export const updateMemberRoleSchema = z
  .object({ role: workspaceRoleSchema })
  .strict();

export const acceptInvitationSchema = z
  .object({ token: z.string().min(1).max(500) })
  .strict();

export const memberParamsSchema = z.object({ userId: z.string().uuid() });
export const invitationParamsSchema = z.object({
  invitationId: z.string().uuid(),
});
