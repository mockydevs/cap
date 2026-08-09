import { describe, expect, it } from "vitest";
import { authorizePlayback, validateShareConfiguration } from "../src/index";

describe("playback authorization", () => {
  it("always allows an authorized workspace member", () => {
    for (const visibility of [
      "PRIVATE",
      "LINK",
      "PASSWORD",
      "PUBLIC",
    ] as const) {
      expect(
        authorizePlayback({
          visibility,
          isWorkspaceMember: true,
          hasActiveShareLink: false,
          passwordVerified: false,
        }),
      ).toEqual({ allowed: true, grant: "WORKSPACE" });
    }
  });

  it("keeps private recordings private", () => {
    expect(
      authorizePlayback({
        visibility: "PRIVATE",
        isWorkspaceMember: false,
        hasActiveShareLink: true,
        passwordVerified: true,
      }),
    ).toEqual({ allowed: false, reason: "WORKSPACE_REQUIRED" });
  });

  it("requires the correct grant for link and password modes", () => {
    expect(
      authorizePlayback({
        visibility: "LINK",
        isWorkspaceMember: false,
        hasActiveShareLink: true,
        passwordVerified: false,
      }),
    ).toEqual({ allowed: true, grant: "LINK" });
    expect(
      authorizePlayback({
        visibility: "PASSWORD",
        isWorkspaceMember: false,
        hasActiveShareLink: true,
        passwordVerified: false,
      }).allowed,
    ).toBe(false);
    expect(
      authorizePlayback({
        visibility: "PASSWORD",
        isWorkspaceMember: false,
        hasActiveShareLink: true,
        passwordVerified: true,
      }),
    ).toEqual({ allowed: true, grant: "PASSWORD" });
  });

  it("only accepts passwords for password-protected shares", () => {
    expect(() =>
      validateShareConfiguration({
        visibility: "PASSWORD",
        password: "too-short",
      }),
    ).toThrow();
    expect(() =>
      validateShareConfiguration({
        visibility: "LINK",
        password: "unnecessary-password",
      }),
    ).toThrow();
    expect(() =>
      validateShareConfiguration({
        visibility: "PASSWORD",
        password: "a strong share password",
      }),
    ).not.toThrow();
  });
});
