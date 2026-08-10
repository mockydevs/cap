import { describe, expect, it } from "vitest";
import { providerConnectionSchema, providerRouteSchema } from "./validation";

describe("AI provider connection validation", () => {
  it("requires custom providers to use an HTTPS endpoint", () => {
    expect(() =>
      providerConnectionSchema.parse({
        provider: "OPENAI_COMPATIBLE",
        displayName: "Local model",
        apiKey: "secret-key",
        allowedCapabilities: ["ANALYSIS"],
        allowedModels: ["model"],
        defaultModel: "model",
      }),
    ).toThrow();
  });

  it("requires the default model to be explicitly allowed", () => {
    expect(() =>
      providerConnectionSchema.parse({
        provider: "OPENAI",
        displayName: "OpenAI",
        apiKey: "secret-key",
        allowedCapabilities: ["ANALYSIS"],
        allowedModels: ["gpt-5-mini"],
        defaultModel: "another-model",
      }),
    ).toThrow();
  });

  it("accepts a workspace-scoped analysis route", () => {
    expect(
      providerRouteSchema.parse({
        purpose: "ANALYSIS",
        connectionId: "00000000-0000-4000-8000-000000000001",
        model: "claude-sonnet-4-5",
      }).purpose,
    ).toBe("ANALYSIS");
  });
});
