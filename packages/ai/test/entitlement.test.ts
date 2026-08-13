import { describe, expect, it } from "vitest";
import {
  resolveAiEntitlement,
  type AiEntitlementFacts,
  type AiPolicyFacts,
} from "../src/entitlement";

const NOW = new Date("2026-08-13T00:00:00.000Z");

const permissivePolicy: AiPolicyFacts = {
  enabled: true,
  allowedProvider: "openai-compatible",
  allowExternalProcessing: true,
  monthlyTokenLimit: 1_000_000,
  monthlyCostLimitMicrounits: 25_000_000,
};

function facts(
  overrides: Partial<AiEntitlementFacts> = {},
): AiEntitlementFacts {
  return {
    purpose: "ANALYSIS",
    policy: permissivePolicy,
    route: null,
    subscription: null,
    usage: { tokens: 0, costMicrounits: 0 },
    deploymentCredentialAllowed: false,
    now: NOW,
    ...overrides,
  };
}

const activePlan = {
  status: "ACTIVE",
  planCode: "starter",
  currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
  includedCreditMicrounits: 5_000_000,
  consumedCreditMicrounits: 0,
};

describe("resolveAiEntitlement", () => {
  it("denies a workspace that has not enabled AI", () =>
    expect(resolveAiEntitlement(facts({ policy: null }))).toEqual({
      lane: "NONE",
      reason: "AI_DISABLED",
    }));

  it("denies external processing without consent", () =>
    expect(
      resolveAiEntitlement(
        facts({
          policy: { ...permissivePolicy, allowExternalProcessing: false },
        }),
      ),
    ).toEqual({ lane: "NONE", reason: "EXTERNAL_AI_DISABLED" }));

  it("allows a self-hosted provider without external consent, because nothing leaves the deployment", () =>
    expect(
      resolveAiEntitlement(
        facts({
          policy: {
            ...permissivePolicy,
            allowedProvider: "self-hosted",
            allowExternalProcessing: false,
          },
          route: { connectionId: "connection", model: "local-model" },
        }),
      ),
    ).toEqual({
      lane: "BYOK",
      connectionId: "connection",
      model: "local-model",
    }));

  it("denies once the workspace cost ceiling is reached even with a key routed", () =>
    expect(
      resolveAiEntitlement(
        facts({
          route: { connectionId: "connection", model: "gpt-5-mini" },
          usage: { tokens: 0, costMicrounits: 25_000_000 },
        }),
      ),
    ).toEqual({ lane: "NONE", reason: "AI_QUOTA_EXCEEDED" }));

  it("prefers the workspace's own key over an active plan", () =>
    expect(
      resolveAiEntitlement(
        facts({
          route: { connectionId: "connection", model: "gpt-5-mini" },
          subscription: activePlan,
        }),
      ),
    ).toEqual({
      lane: "BYOK",
      connectionId: "connection",
      model: "gpt-5-mini",
    }));

  it("uses the plan when no key is routed for the purpose", () =>
    expect(
      resolveAiEntitlement(
        facts({
          subscription: { ...activePlan, consumedCreditMicrounits: 1_000_000 },
        }),
      ),
    ).toEqual({
      lane: "MANAGED",
      planCode: "starter",
      remainingCreditMicrounits: 4_000_000,
    }));

  it("denies an exhausted plan rather than falling through to the deployment credential", () =>
    expect(
      resolveAiEntitlement(
        facts({
          subscription: { ...activePlan, consumedCreditMicrounits: 5_000_000 },
          deploymentCredentialAllowed: true,
        }),
      ),
    ).toEqual({ lane: "NONE", reason: "AI_CREDIT_EXHAUSTED" }));

  it("treats a lapsed period as unconfigured", () =>
    expect(
      resolveAiEntitlement(
        facts({
          subscription: {
            ...activePlan,
            currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
          },
        }),
      ),
    ).toEqual({ lane: "NONE", reason: "AI_PROVIDER_NOT_CONFIGURED" }));

  it("treats a non-paying status as unconfigured", () =>
    expect(
      resolveAiEntitlement(
        facts({ subscription: { ...activePlan, status: "CANCELED" } }),
      ),
    ).toEqual({ lane: "NONE", reason: "AI_PROVIDER_NOT_CONFIGURED" }));

  it("falls back to the deployment credential only when the operator opted in", () => {
    expect(resolveAiEntitlement(facts())).toEqual({
      lane: "NONE",
      reason: "AI_PROVIDER_NOT_CONFIGURED",
    });
    expect(
      resolveAiEntitlement(facts({ deploymentCredentialAllowed: true })),
    ).toEqual({ lane: "DEPLOYMENT" });
  });
});
