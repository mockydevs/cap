import { WORKSPACE_ROLES } from "@cap/domain";
import { describe, expect, it } from "vitest";
import { workspaceRole } from "../../db/schema";
import { hashInvitationToken } from "./service";
import {
  acceptInvitationSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
} from "./validation";

describe("workspace roles", () => {
  it("declares the same ladder in the database enum and the domain", () => {
    expect(workspaceRole.enumValues).toEqual([...WORKSPACE_ROLES]);
  });
});

describe("workspace invitation primitives", () => {
  it("hashes invitation tokens deterministically without leaking the token", () => {
    const token = "example-token-value";
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).not.toContain(token);
  });

  it("rejects inviting a new member directly as owner", () => {
    expect(() =>
      inviteMemberSchema.parse({ email: "a@example.com", role: "OWNER" }),
    ).toThrow();
    expect(
      inviteMemberSchema.parse({ email: "A@Example.com", role: "MEMBER" }),
    ).toMatchObject({ email: "a@example.com", role: "MEMBER" });
  });

  it("allows any role, including owner, for role updates", () => {
    expect(updateMemberRoleSchema.parse({ role: "OWNER" })).toEqual({
      role: "OWNER",
    });
  });

  it("requires a non-empty invitation token to accept", () => {
    expect(() => acceptInvitationSchema.parse({ token: "" })).toThrow();
    expect(acceptInvitationSchema.parse({ token: "abc" })).toEqual({
      token: "abc",
    });
  });
});
