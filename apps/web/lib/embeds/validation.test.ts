import { describe, expect, it } from "vitest";
import { embedPlaybackSchema, embedPolicySchema } from "./validation";

describe("embed policy contract", () => {
  it("requires an explicit origin before enabling a recording embed", () => {
    expect(() =>
      embedPolicySchema.parse({ enabled: true, allowedOrigins: [] }),
    ).toThrow("Enabled embeds require an origin");
  });

  it("normalizes configured HTTPS origins and rejects duplicate or unsafe origins", () => {
    expect(
      embedPolicySchema.parse({
        enabled: true,
        allowedOrigins: ["https://docs.example.com/a-path"],
      }).allowedOrigins,
    ).toEqual(["https://docs.example.com"]);
    expect(() =>
      embedPolicySchema.parse({
        enabled: true,
        allowedOrigins: [
          "https://docs.example.com",
          "https://docs.example.com",
        ],
      }),
    ).toThrow("Embed origins must be unique");
    expect(() =>
      embedPolicySchema.parse({
        enabled: true,
        allowedOrigins: ["ftp://docs.example.com"],
      }),
    ).toThrow();
  });

  it("only accepts a complete high-entropy share token for an embed playback grant", () => {
    expect(
      embedPlaybackSchema.parse({
        shareToken: "A".repeat(43),
        password: "a share password",
      }),
    ).toMatchObject({ shareToken: "A".repeat(43) });
    expect(() => embedPlaybackSchema.parse({ shareToken: "short" })).toThrow();
  });
});
