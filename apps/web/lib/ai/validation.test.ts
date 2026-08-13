import { describe, expect, it } from "vitest";
import {
  aiPolicySchema,
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

describe("AI policy round trip", () => {
  // The settings form posts back exactly what GET /api/ai/policy returned, so
  // the read shape and the write schema have to agree. They did not: the read
  // returned the whole row, the schema is strict, and every save failed with a
  // validation error — which left AI impossible to switch on.
  const editable = {
    enabled: true,
    allowedProvider: "openai-compatible" as const,
    allowExternalProcessing: true,
    monthlyTokenLimit: 1_000_000,
    monthlyCostLimitMicrounits: 25_000_000,
  };

  it("accepts the shape the policy endpoint hands the form", () => {
    expect(aiPolicySchema.parse(editable).enabled).toBe(true);
  });

  it("rejects a payload carrying a persistence column", () => {
    expect(() =>
      aiPolicySchema.parse({
        ...editable,
        workspaceId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      }),
    ).toThrow();
  });
});
