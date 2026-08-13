import { describe, expect, it } from "vitest";
import { authorizePlayback } from "../src/index";

describe("playback authorization", () => {
  it("always allows an authorized workspace member", () => {
    for (const visibility of ["PRIVATE", "LINK", "PUBLIC"] as const) {
      expect(
        authorizePlayback({
          visibility,
          isWorkspaceMember: true,
          hasActiveShareLink: false,
        }),
      ).toEqual({ allowed: true, grant: "WORKSPACE" });
    }
  });

  it("keeps private recordings private, link or no link", () => {
    expect(
      authorizePlayback({
        visibility: "PRIVATE",
        isWorkspaceMember: false,
        hasActiveShareLink: true,
      }),
    ).toEqual({ allowed: false, reason: "WORKSPACE_REQUIRED" });
  });

  it("treats the link itself as the credential for a link share", () => {
    expect(
      authorizePlayback({
        visibility: "LINK",
        isWorkspaceMember: false,
        hasActiveShareLink: true,
      }),
    ).toEqual({ allowed: true, grant: "LINK" });
    expect(
      authorizePlayback({
        visibility: "LINK",
        isWorkspaceMember: false,
        hasActiveShareLink: false,
      }),
    ).toEqual({ allowed: false, reason: "LINK_REQUIRED" });
  });

  it("lets anyone watch a public recording", () => {
    expect(
      authorizePlayback({
        visibility: "PUBLIC",
        isWorkspaceMember: false,
        hasActiveShareLink: false,
      }),
    ).toEqual({ allowed: true, grant: "PUBLIC" });
  });
});
