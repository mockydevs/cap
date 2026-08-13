import { describe, expect, it } from "vitest";
import {
  providerConnectionSchema,
  providerModelsLookupSchema,
  providerRouteSchema,
  rotateProviderConnectionSchema,
} from "./validation";

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

  it("accepts an embeddings or transcription route, not just analysis", () => {
    for (const purpose of ["EMBEDDINGS", "TRANSCRIPTION"] as const) {
      expect(
        providerRouteSchema.parse({
          purpose,
          connectionId: "00000000-0000-4000-8000-000000000001",
          model: "text-embedding-3-large",
        }).purpose,
      ).toBe(purpose);
    }
  });
});

describe("AI provider models lookup validation", () => {
  it("requires an HTTPS base URL for a custom provider", () => {
    expect(() =>
      providerModelsLookupSchema.parse({
        provider: "OPENAI_COMPATIBLE",
        apiKey: "secret-key",
      }),
    ).toThrow();
  });

  it("does not require a base URL for OpenAI or Anthropic", () => {
    expect(() =>
      providerModelsLookupSchema.parse({
        provider: "OPENAI",
        apiKey: "secret-key",
      }),
    ).not.toThrow();
  });
});

describe("AI provider connection rotation validation", () => {
  it("rejects an empty API key", () => {
    expect(() =>
      rotateProviderConnectionSchema.parse({ apiKey: "" }),
    ).toThrow();
  });

  it("accepts a plausible API key", () => {
    expect(
      rotateProviderConnectionSchema.parse({ apiKey: "sk-rotated-key" }).apiKey,
    ).toBe("sk-rotated-key");
  });
});
