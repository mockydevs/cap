import { describe, expect, it } from "vitest";
import {
  applyManagedMarkup,
  CONSERVATIVE_TOKEN_RATE,
  estimateAudioCostMicrounits,
  estimateTokenCostMicrounits,
  hasPublishedTokenRate,
  resolveTokenRate,
  unknownTokenRateFromEnvironment,
} from "../src/rates";

describe("model rates", () => {
  it("prices each provider from its own list rather than one blended rate", () => {
    expect(resolveTokenRate("gpt-5-mini")).toEqual({
      inputMicrounitsPerMillion: 250_000,
      outputMicrounitsPerMillion: 2_000_000,
    });
    expect(resolveTokenRate("claude-opus-5")).toEqual({
      inputMicrounitsPerMillion: 5_000_000,
      outputMicrounitsPerMillion: 25_000_000,
    });
  });

  it("prices a dated or vendor-prefixed deployment as its base model", () => {
    expect(resolveTokenRate("gpt-4o-2024-08-06")).toEqual(
      resolveTokenRate("gpt-4o"),
    );
    expect(resolveTokenRate("anthropic.claude-sonnet-5")).toEqual(
      resolveTokenRate("claude-sonnet-5"),
    );
  });

  it("does not let a shorter model name claim a longer one", () => {
    expect(resolveTokenRate("gpt-5-mini")).not.toEqual(
      resolveTokenRate("gpt-5"),
    );
    expect(hasPublishedTokenRate("gpt-51-imaginary")).toBe(false);
  });

  it("prices an unknown model conservatively so a ceiling never under-counts", () =>
    expect(resolveTokenRate("some-private-model")).toEqual(
      CONSERVATIVE_TOKEN_RATE,
    ));

  it("lets the operator override the unknown-model rate", () =>
    expect(
      resolveTokenRate(
        "some-private-model",
        unknownTokenRateFromEnvironment({
          AI_INPUT_COST_MICROUNITS_PER_MILLION: "1000",
          AI_OUTPUT_COST_MICROUNITS_PER_MILLION: "2000",
        }),
      ),
    ).toEqual({
      inputMicrounitsPerMillion: 1000,
      outputMicrounitsPerMillion: 2000,
    }));

  it("ignores a blank or malformed override", () =>
    expect(
      unknownTokenRateFromEnvironment({
        AI_INPUT_COST_MICROUNITS_PER_MILLION: "",
        AI_OUTPUT_COST_MICROUNITS_PER_MILLION: "not-a-number",
      }),
    ).toBeUndefined());

  it("estimates token cost from the resolved rate", () =>
    expect(
      estimateTokenCostMicrounits({
        model: "gpt-5-mini",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      }),
    ).toBe(250_000 + 1_000_000));

  it("estimates audio cost per minute of billed duration", () =>
    expect(
      estimateAudioCostMicrounits({
        model: "gpt-4o-mini-transcribe",
        durationMs: 120_000,
      }),
    ).toBe(6_000));

  it("adds the operator margin to managed-lane spend", () => {
    expect(applyManagedMarkup(1_000, 30)).toBe(1_300);
    expect(applyManagedMarkup(1_000, 0)).toBe(1_000);
  });
});
